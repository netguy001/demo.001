"""
Zebu Master Contract Loader — fetches NSE/BSE symbol-token mappings.

Zebu (MYNT) publishes master contract files at public CDN URLs.
These files map every tradeable instrument's token to its trading symbol.

Called at startup in main.py so the symbol_mapper has full coverage
beyond the 20 hardcoded stocks.
"""

import io
import logging
import zipfile
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# Public Zebu/MYNT contract CDN (no auth required)
_NSE_CONTRACT_URL = "https://go.mynt.in/NSE_symbols.txt.zip"
_NSE_FALLBACK_URL = "https://api.zebull.in/NSE_symbols.txt.zip"


async def fetch_zebu_contracts(exchange: str = "NSE") -> list[dict]:
    """
    Download and parse the Zebu master contract file for an exchange.

    Returns a list of dicts with keys: symbol, token, exchange
    Only equity instruments (TradingSymbol ending in -EQ) are included.
    """
    urls = (
        [_NSE_CONTRACT_URL, _NSE_FALLBACK_URL]
        if exchange == "NSE"
        else []
    )

    raw_zip: Optional[bytes] = None
    for url in urls:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(url, follow_redirects=True)
                if resp.status_code == 200 and resp.content:
                    raw_zip = resp.content
                    logger.info(
                        f"Downloaded Zebu {exchange} contracts from {url} "
                        f"({len(raw_zip):,} bytes)"
                    )
                    break
                else:
                    logger.warning(
                        f"Zebu contract download failed: {url} → HTTP {resp.status_code}"
                    )
        except Exception as e:
            logger.warning(f"Zebu contract download error ({url}): {e}")

    if not raw_zip:
        logger.error(f"Could not download Zebu {exchange} master contracts")
        return []

    return _parse_contract_zip(raw_zip, exchange)


def _parse_contract_zip(raw_zip: bytes, exchange: str) -> list[dict]:
    """
    Parse a Zebu master contract ZIP file.

    The ZIP contains a single text file with pipe-delimited rows.
    Format (header + data rows):
        Exchange|Token|TradingSymbol|ShortName|Expiry|StrikePrice|OptionType|...

    We only extract NSE equity instruments (TradingSymbol ends in -EQ).
    """
    contracts = []
    try:
        with zipfile.ZipFile(io.BytesIO(raw_zip)) as zf:
            # Find the .txt file inside the ZIP
            txt_files = [n for n in zf.namelist() if n.endswith(".txt")]
            if not txt_files:
                logger.error("No .txt file found in Zebu contract ZIP")
                return []

            with zf.open(txt_files[0]) as f:
                raw_bytes = f.read()
                try:
                    content = raw_bytes.decode("utf-8")
                except UnicodeDecodeError:
                    content = raw_bytes.decode("latin-1", errors="replace")

        lines = content.splitlines()
        if not lines:
            return []

        # Parse header to find column indices
        header = [col.strip().lower() for col in lines[0].split("|")]
        try:
            exch_idx = header.index("exchange") if "exchange" in header else 0
            token_idx = next(
                (i for i, h in enumerate(header) if "token" in h), 1
            )
            sym_idx = next(
                (i for i, h in enumerate(header) if "symbol" in h or "tradingsymbol" in h.replace(" ", "")),
                2,
            )
        except (ValueError, StopIteration):
            # Fallback: assume Exchange|Token|TradingSymbol column order
            exch_idx, token_idx, sym_idx = 0, 1, 2

        for line in lines[1:]:
            parts = line.split("|")
            if len(parts) <= max(exch_idx, token_idx, sym_idx):
                continue

            exch = parts[exch_idx].strip()
            token = parts[token_idx].strip()
            trading_sym = parts[sym_idx].strip()

            # Only process equity instruments
            if not trading_sym.endswith("-EQ"):
                continue
            if not token or not token.isdigit():
                continue

            # Extract base symbol: "RELIANCE-EQ" → "RELIANCE"
            base_sym = trading_sym[:-3]  # strip "-EQ"

            contracts.append(
                {
                    "symbol": base_sym,
                    "token": token,
                    "exchange": exch or exchange,
                }
            )

        logger.info(
            f"Parsed {len(contracts)} equity instruments from "
            f"Zebu {exchange} master contracts"
        )
    except Exception as e:
        logger.error(f"Failed to parse Zebu contract ZIP: {e}", exc_info=True)

    return contracts
