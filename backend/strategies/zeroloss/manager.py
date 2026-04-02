"""Per-user ZeroLoss controller manager.

Runs one ZeroLossController task per user so strategy state, positions,
and stats remain isolated across users.
"""

import asyncio
import logging
from typing import Optional

from strategies.zeroloss.controller import ZeroLossController

logger = logging.getLogger(__name__)


class ZeroLossManager:
    def __init__(self):
        self._controllers: dict[str, ZeroLossController] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._lock = asyncio.Lock()

    @staticmethod
    def _normalize_user_id(user_id: Optional[object]) -> str:
        if user_id is None:
            raise ValueError("user_id is required")
        return str(user_id)

    def get_controller(self, user_id: object) -> ZeroLossController:
        uid = self._normalize_user_id(user_id)
        controller = self._controllers.get(uid)
        if controller is None:
            controller = ZeroLossController()
            controller.set_user(user_id)
            self._controllers[uid] = controller
        else:
            controller.set_user(user_id)
        return controller

    async def enable(self, user_id: object) -> ZeroLossController:
        uid = self._normalize_user_id(user_id)
        async with self._lock:
            controller = self.get_controller(user_id)
            controller.enable(user_id=user_id)

            task = self._tasks.get(uid)
            if task is None or task.done():
                self._tasks[uid] = asyncio.create_task(
                    controller.run(), name=f"zeroloss:{uid}"
                )
                logger.info(f"ZeroLoss worker started for user {uid[:8]}...")
            return controller

    async def disable(
        self, user_id: object, close_positions: bool = True
    ) -> list[dict]:
        uid = self._normalize_user_id(user_id)
        async with self._lock:
            controller = self._controllers.get(uid)
            if controller is None:
                return []

            closed: list[dict] = []
            if close_positions:
                closed = await controller.close_all_positions()
            controller.disable()
            await controller.stop()

            task = self._tasks.pop(uid, None)
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                except Exception:
                    logger.exception(
                        "ZeroLoss worker task failed while stopping user %s", uid
                    )

            logger.info(f"ZeroLoss worker stopped for user {uid[:8]}...")
            return closed

    async def stop_all(self) -> None:
        user_ids = list(self._controllers.keys())
        for uid in user_ids:
            try:
                await self.disable(uid, close_positions=False)
            except Exception:
                logger.exception("Failed to stop ZeroLoss worker for user %s", uid)

    def get_stats(self) -> dict:
        enabled_users = [
            uid
            for uid, controller in self._controllers.items()
            if controller.is_enabled()
        ]
        running_tasks = [uid for uid, task in self._tasks.items() if not task.done()]
        return {
            "enabled_users": len(enabled_users),
            "running_workers": len(running_tasks),
            "users": [uid[:8] for uid in enabled_users],
        }


zeroloss_manager = ZeroLossManager()
