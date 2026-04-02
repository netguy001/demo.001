"""
Symbol Mapper — Translates between AlphaSync canonical symbols and
provider-specific symbol formats.

AlphaSync uses Yahoo Finance-style symbols as canonical:
    NSE equities:   RELIANCE.NS, TCS.NS, HDFCBANK.NS
    Indices:        ^NSEI, ^BSESN
    MCX commodities: GOLD, SILVER, CRUDEOIL  (no suffix — MCX exchange tag in mapping)

Each provider may use different formats:
    - Zebu NSE: RELIANCE-EQ  (exchange token-based, NSE segment)
    - Zebu MCX: GOLD, GOLDM, CRUDEOIL  (exchange token-based, MCX segment)

The map starts empty and is populated at startup by fetch_zebu_contracts()
which downloads the full master contract file directly from Zebu's API.
Any symbol not yet in the map is resolved on-demand via SearchScrip.
"""

import logging
from typing import Optional

logger = logging.getLogger(__name__)

# ── Known MCX commodity symbols ────────────────────────────────────
# Used to detect commodity symbols and avoid appending .NS to them.
MCX_COMMODITY_SYMBOLS = {
    "GOLD", "GOLDM", "GOLDGUINEA", "GOLDPETAL",
    "SILVER", "SILVERM", "SILVERMIC",
    "COPPER", "CRUDEOIL", "NATURALGAS",
    "ALUMINIUM", "ZINC", "LEAD", "NICKEL",
    "COTTON", "CASTORSEED", "SOYBEAN", "GUARSEED",
    "RMSEED", "CHANA", "MENTHOIL",
}


def is_mcx_symbol(symbol: str) -> bool:
    """Check if a symbol is a known MCX commodity."""
    clean = symbol.upper().strip()
    return clean in MCX_COMMODITY_SYMBOLS


# ── Zebu symbol mapping ────────────────────────────────────────────
# Populated at startup from Zebu master contracts (all ~1800 NSE equities).
# Also populated on-demand via _resolve_symbol() → SearchScrip API.
# Format: canonical_symbol -> { "trading_symbol": str, "token": str, "exchange": str }

_ZEBU_SYMBOL_MAP: dict[str, dict] = {
    # ── NSE Indices (Zebu well-known index tokens) ───────────────────
    "^NSEI":    {"trading_symbol": "Nifty 50",   "token": "26000", "exchange": "NSE"},
    "^NSEBANK": {"trading_symbol": "Nifty Bank", "token": "26009", "exchange": "NSE"},
    "^CNXIT":   {"trading_symbol": "Nifty IT",   "token": "26008", "exchange": "NSE"},
    "^BSESN":   {"trading_symbol": "SENSEX",     "token": "1",     "exchange": "BSE"},
}

# Reverse map: token -> canonical_symbol (for incoming tick parsing)
_TOKEN_TO_CANONICAL: dict[str, str] = {
    v["token"]: k for k, v in _ZEBU_SYMBOL_MAP.items()
}

# Reverse map: trading_symbol -> canonical_symbol
_TRADING_TO_CANONICAL: dict[str, str] = {
    v["trading_symbol"]: k for k, v in _ZEBU_SYMBOL_MAP.items()
}


def canonical_to_zebu(symbol: str) -> Optional[dict]:
    """
    Convert AlphaSync canonical symbol to Zebu format.

    Returns:
        {"trading_symbol": "RELIANCE-EQ", "token": "2885", "exchange": "NSE"}
        or None if not yet mapped (call _resolve_symbol to populate on-demand).
    """
    return _ZEBU_SYMBOL_MAP.get(symbol)


def zebu_token_to_canonical(token: str) -> Optional[str]:
    """Convert Zebu exchange token to AlphaSync canonical symbol."""
    return _TOKEN_TO_CANONICAL.get(token)


def zebu_trading_to_canonical(trading_symbol: str) -> Optional[str]:
    """Convert Zebu trading symbol to AlphaSync canonical symbol."""
    return _TRADING_TO_CANONICAL.get(trading_symbol)


def get_all_zebu_tokens() -> list[dict]:
    """Return all mapped Zebu tokens for bulk subscription."""
    return [{"canonical": k, **v} for k, v in _ZEBU_SYMBOL_MAP.items()]


def load_zebu_contracts(contracts: list[dict]) -> int:
    """
    Load / refresh Zebu symbol mappings from master contract data.

    Expected format per contract:
        {"symbol": "RELIANCE", "token": "2885", "exchange": "NSE", ...}
        {"symbol": "GOLD",     "token": "...",  "exchange": "MCX", "trading_symbol": "GOLD"}

    Call this at startup after fetching the master contract file from Zebu.
    Returns the number of symbols loaded.
    """
    global _ZEBU_SYMBOL_MAP, _TOKEN_TO_CANONICAL, _TRADING_TO_CANONICAL
    count = 0

    for c in contracts:
        sym = c.get("symbol", "").strip()
        token = str(c.get("token", "")).strip()
        exchange = c.get("exchange", "NSE").strip().upper()

        if not sym or not token:
            continue

        if exchange == "MCX":
            # MCX commodities: canonical is just the symbol (e.g. "GOLD")
            canonical = sym.upper()
            trading = c.get("trading_symbol", sym.upper())
        elif exchange == "NSE":
            canonical = f"{sym}.NS"
            trading = f"{sym}-EQ"
        else:
            canonical = f"{sym}.BO"
            trading = f"{sym}-EQ"

        _ZEBU_SYMBOL_MAP[canonical] = {
            "trading_symbol": trading,
            "token": token,
            "exchange": exchange,
        }
        _TOKEN_TO_CANONICAL[token] = canonical
        _TRADING_TO_CANONICAL[trading] = canonical
        count += 1

    logger.info(
        f"Loaded {count} Zebu contract mappings (total: {len(_ZEBU_SYMBOL_MAP)})"
    )
    return count
