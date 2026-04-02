/**
 * Validate an order form before submission.
 * @param {{ side: string, order_type: string, trading_mode: string, quantity: number|string, price: number|string, triggerPrice: number|string }} form
 * @returns {{ valid: boolean, error: string|null }}
 */
export const validateOrderForm = ({ side, order_type, trading_mode, quantity, price, triggerPrice }) => {
    const qty = parseInt(quantity, 10);
    if (!qty || qty <= 0) return { valid: false, error: 'Quantity must be a positive integer.' };

    if (order_type === 'LIMIT') {
        const p = parseFloat(price);
        if (!p || p <= 0) return { valid: false, error: 'Limit price must be a positive number.' };
    }

    if (order_type === 'SL' || order_type === 'SL-M') {
        const tp = parseFloat(triggerPrice);
        if (!tp || tp <= 0) return { valid: false, error: 'Trigger price must be a positive number.' };
    }

    // Trading mode must be set
    if (!trading_mode || !['DELIVERY', 'INTRADAY'].includes(trading_mode)) {
        return { valid: false, error: 'Please select a trading type (Delivery or Intraday).' };
    }

    return { valid: true, error: null };
};

/**
 * Validate an email address.
 * @param {string} email
 * @returns {boolean}
 */
export const isValidEmail = (email) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/**
 * Check if a password meets minimum requirements (8+ chars, 1 number).
 * @param {string} password
 * @returns {{ valid: boolean, error: string|null }}
 */
export const validatePassword = (password) => {
    if (!password || password.length < 8) return { valid: false, error: 'Password must be at least 8 characters.' };
    if (!/\d/.test(password)) return { valid: false, error: 'Password must contain at least one number.' };
    return { valid: true, error: null };
};
