# Watchlist Debugging Guide

## Quick Test Steps:

### 1. **Open Browser Console**
   - Press `F12` or `Ctrl+Shift+I` (Windows)
   - Go to the **Console** tab
   - Keep it open while testing

### 2. **Open Trading Terminal**
   - Load the terminal page
   - Look for console logs starting with `[Watchlist]`

### 3. **Add a Stock to Watchlist**
   - Click the star icon in the search bar (top left)
   - Or click the star icon in the chart header
   - Watch the console for messages like:
     - `[Watchlist] addItem called with: {symbol, exchange}`
     - `[Watchlist] Fetching prices for symbols: RELIANCE.NS`
     - `[Watchlist] Got quotes response: {...}`

### 4. **Check for Issues**

#### If you see `[Watchlist] No activeId after loadWatchlist`:
   - The watchlist store didn't initialize properly
   - Check: Is localStorage accessible? (try in console: `localStorage.setItem('test', 'test')`)

#### If you see `[Watchlist] Fetching prices for symbols: ...` but NO `Got quotes response`:
   - The API call is failing
   - Check browser Network tab (F12 > Network) to see `/market/batch` request
   - Look for error status code (4xx or 5xx)

#### If you see `Got quotes response:` but prices still don't show:
   - The price data format might be wrong
   - Look at the quotes object structure in console
   - Should have fields like: `price`, `change`, `change_percent`

#### If watchlist disappears after refresh:
   - Check console for: `[Watchlist] Loaded from localStorage:`
   - If empty or not shown, localStorage persistence is not working
   - Try: `localStorage.getItem('alphasync_watchlists')` in console

## Quick Console Commands to Test:

```javascript
// Check current watchlist state
useWatchlistStore.getState()

// Check localStorage
localStorage.getItem('alphasync_watchlists')

// Manually fetch prices
useWatchlistStore.getState().fetchPrices()

// Clear watchlist (if stuck)
localStorage.removeItem('alphasync_watchlists')
```

## Expected Console Output Flow:

```
[Watchlist] loadWatchlist called
[Watchlist] Loaded from localStorage: {watchlists: [...], activeId: "..."}
[Watchlist] Using cached watchlists from localStorage
[Watchlist] Attempting to sync with server
[Watchlist] Got watchlists from server: [...]
[Watchlist] addItem called with: {symbol: "RELIANCE.NS", exchange: "NSE"}
[Watchlist] Adding symbol optimistically: {tempId: "temp_1711234567890", symbol: "RELIANCE.NS"}
[Watchlist] State after optimistic add: [...]
[Watchlist] Persisting to localStorage: {...}
[Watchlist] Successfully persisted to localStorage
[Watchlist] Fetching prices after add
[Watchlist] Fetching prices for symbols: RELIANCE.NS
[Watchlist] Got quotes response: {RELIANCE.NS: {price: 2384, change: 10, ...}}
[Watchlist] Setting normalized prices: {...}
```

## Files Modified:
- `frontend/src/stores/useWatchlistStore.js` - Added comprehensive logging
- `frontend/src/components/trading/Watchlist.jsx` - Added fetchPrices destructuring
- `frontend/src/pages/TradingTerminalPage.jsx` - Already calling loadWatchlist

## Next Steps if Still Failing:
1. **Share console logs** starting with `[Watchlist]`
2. **Check Network tab** for `/market/batch` requests
3. **Check browser Storage** (DevTools > Application > Local Storage)
