/**
 * Cart Recovery System for Anhance.chat
 * Automated cart recovery with personalized follow-ups and discount offers
 */

const botConfig = require('../config/bot_prompts');

class CartRecoverySystem {
    constructor() {
        this.activeCarts = new Map(); // userId -> cart data
        this.recoveryJobs = new Map(); // userId -> scheduled jobs
        this.recoveryHistory = new Map(); // userId -> recovery attempts history
    }

    /**
     * Track abandoned cart
     */
    trackAbandonedCart(userId, cartData) {
        if (!botConfig.tools.cart_recovery) return;

        const cartInfo = {
            userId,
            items: cartData.items || [],
            totalValue: cartData.totalValue || 0,
            abandonedAt: Date.now(),
            sessionId: cartData.sessionId,
            products: cartData.products || [],
            discountApplied: false,
            recoveryAttempts: 0
        };

        this.activeCarts.set(userId, cartInfo);
        this.scheduleRecoveryReminder(userId);
        
        console.log(`Cart recovery tracked for user ${userId} with ${cartInfo.items.length} items worth ₹${cartInfo.totalValue}`);
        
        return cartInfo;
    }

    /**
     * Schedule recovery reminder
     */
    scheduleRecoveryReminder(userId) {
        const cart = this.activeCarts.get(userId);
        if (!cart) return;

        // Clear existing job
        if (this.recoveryJobs.has(userId)) {
            clearTimeout(this.recoveryJobs.get(userId));
        }

        const reminderDelay = botConfig.advanced.cart_recovery.abandonment_threshold;
        const maxReminders = 3;
        const nextReminderTime = cart.recoveryAttempts * reminderDelay;
        
        if (cart.recoveryAttempts >= maxReminders) {
            this.markCartAsExpired(userId);
            return;
        }

        const job = setTimeout(() => {
            this.sendRecoveryMessage(userId);
        }, nextReminderTime);

        this.recoveryJobs.set(userId, job);
    }

    /**
     * Send recovery message
     */
    async sendRecoveryMessage(userId) {
        const cart = this.activeCarts.get(userId);
        if (!cart) return;

        const recoveryAttempt = cart.recoveryAttempts + 1;
        const messages = {
            first_reminder: "Hi! We noticed you left some items in your cart. Would you like to complete your purchase?",
            second_reminder: "Still thinking about your items? We've applied a small discount to help you decide!",
            final_reminder: "Final call! Your cart is about to expire. Here's our best offer to help you complete your order."
        };
        
        let message = '';
        let shouldApplyDiscount = false;

        switch (recoveryAttempt) {
            case 1:
                message = messages.first_reminder;
                shouldApplyDiscount = cart.totalValue >= 1000;
                break;
            case 2:
                message = messages.second_reminder;
                shouldApplyDiscount = cart.totalValue >= 800;
                break;
            case 3:
                message = messages.final_reminder;
                shouldApplyDiscount = true; // Always offer discount on final attempt
                break;
            default:
                this.markCartAsExpired(userId);
                return;
        }

        // Apply discount if eligible
        if (shouldApplyDiscount && !cart.discountApplied) {
            const discountCode = this.generateDiscountCode(userId);
            const discountAmount = Math.round(cart.totalValue * 0.1); // 10%
            
            message += `\n\nUse code ${discountCode} to save ₹${discountAmount} on your order! 🎉`;
            cart.discountApplied = true;
            cart.discountCode = discountCode;
            cart.discountAmount = discountAmount;
        }

        // Personalize message with cart details
        if (cart.items.length > 0) {
            const topItems = cart.items.slice(0, 3).map(item => item.name).join(', ');
            message += `\n\nYour cart contains: ${topItems}${cart.items.length > 3 ? ' and more' : ''}`;
        }

        // Add urgency based on attempt
        if (recoveryAttempt >= 2) {
            message += `\n\n⏰ Limited time offer - Don't miss out!`;
        }

        // Update cart data
        cart.recoveryAttempts = recoveryAttempt;
        cart.lastRecoveryAttempt = Date.now();
        
        // Store recovery attempt
        const history = this.recoveryHistory.get(userId) || [];
        history.push({
            attempt: recoveryAttempt,
            timestamp: Date.now(),
            message: message,
            discountApplied: cart.discountApplied
        });
        this.recoveryHistory.set(userId, history);

        // Send message (this would integrate with your messaging system)
        await this.deliverRecoveryMessage(userId, message);

        // Schedule next reminder if not expired
        if (recoveryAttempt < 3) {
            this.scheduleRecoveryReminder(userId);
        } else {
            this.markCartAsExpired(userId);
        }
    }

    /**
     * Deliver recovery message through appropriate channel
     */
    async deliverRecoveryMessage(userId, message) {
        // This would integrate with your existing messaging system
        // For now, we'll log it
        console.log(`Cart recovery message for user ${userId}: ${message}`);
        
        // You can integrate with WhatsApp, Instagram, Facebook, or website messaging
        // Example integration points:
        // - WhatsApp Business API
        // - Facebook Messenger API
        // - Instagram Messaging API
        // - Website chat widget
        
        return true;
    }

    /**
     * Generate unique discount code
     */
    generateDiscountCode(userId) {
        const timestamp = Date.now().toString(36).slice(-4);
        const userHash = userId.slice(-4);
        return `ANHANCE${userHash}${timestamp}`.toUpperCase();
    }

    /**
     * Mark cart as recovered
     */
    markCartAsRecovered(userId, orderData) {
        const cart = this.activeCarts.get(userId);
        if (!cart) return;

        // Clear recovery jobs
        if (this.recoveryJobs.has(userId)) {
            clearTimeout(this.recoveryJobs.get(userId));
            this.recoveryJobs.delete(userId);
        }

        // Update cart status
        cart.status = 'recovered';
        cart.recoveredAt = Date.now();
        cart.orderData = orderData;

        // Log recovery success
        console.log(`Cart recovered for user ${userId}! Order value: ₹${orderData.totalValue || cart.totalValue}`);

        // Remove from active tracking after a delay
        setTimeout(() => {
            this.activeCarts.delete(userId);
            this.recoveryHistory.delete(userId);
        }, 24 * 60 * 60 * 1000); // Keep for 24 hours

        return cart;
    }

    /**
     * Mark cart as expired
     */
    markCartAsExpired(userId) {
        const cart = this.activeCarts.get(userId);
        if (!cart) return;

        // Clear recovery jobs
        if (this.recoveryJobs.has(userId)) {
            clearTimeout(this.recoveryJobs.get(userId));
            this.recoveryJobs.delete(userId);
        }

        cart.status = 'expired';
        cart.expiredAt = Date.now();

        console.log(`Cart recovery expired for user ${userId} after ${cart.recoveryAttempts} attempts`);

        // Remove from active tracking
        setTimeout(() => {
            this.activeCarts.delete(userId);
            this.recoveryHistory.delete(userId);
        }, 7 * 24 * 60 * 60 * 1000); // Keep for 7 days for analytics

        return cart;
    }

    /**
     * Get cart recovery statistics
     */
    getRecoveryStats() {
        const stats = {
            totalAbandonedCarts: this.activeCarts.size,
            totalRecoveryAttempts: 0,
            successfulRecoveries: 0,
            expiredCarts: 0,
            averageCartValue: 0,
            recoveryRate: 0
        };

        let totalValue = 0;
        let recoveredValue = 0;

        for (const [userId, cart] of this.activeCarts) {
            stats.totalRecoveryAttempts += cart.recoveryAttempts;
            totalValue += cart.totalValue;

            if (cart.status === 'recovered') {
                stats.successfulRecoveries++;
                recoveredValue += cart.totalValue;
            } else if (cart.status === 'expired') {
                stats.expiredCarts++;
            }
        }

        stats.averageCartValue = totalValue / Math.max(this.activeCarts.size, 1);
        stats.recoveryRate = (stats.successfulRecoveries / Math.max(this.activeCarts.size, 1)) * 100;

        return stats;
    }

    /**
     * Get user cart status
     */
    getUserCartStatus(userId) {
        const cart = this.activeCarts.get(userId);
        const history = this.recoveryHistory.get(userId) || [];

        return {
            hasActiveCart: !!cart,
            cart: cart,
            recoveryHistory: history,
            nextReminder: cart && cart.recoveryAttempts < 3 
                ? new Date(Date.now() + botConfig.advanced.cart_recovery.abandonment_threshold)
                : null
        };
    }

    /**
     * Cancel cart recovery for user
     */
    cancelCartRecovery(userId) {
        if (this.recoveryJobs.has(userId)) {
            clearTimeout(this.recoveryJobs.get(userId));
            this.recoveryJobs.delete(userId);
        }

        const cart = this.activeCarts.get(userId);
        if (cart) {
            cart.status = 'cancelled';
            cart.cancelledAt = Date.now();
        }

        console.log(`Cart recovery cancelled for user ${userId}`);
        return cart;
    }

    /**
     * Process cart recovery webhook
     */
    async processWebhook(webhookData) {
        const { event, userId, cartData, orderData } = webhookData;

        switch (event) {
            case 'cart_abandoned':
                return this.trackAbandonedCart(userId, cartData);
            
            case 'order_completed':
                return this.markCartAsRecovered(userId, orderData);
            
            case 'cart_recovered':
                return this.markCartAsRecovered(userId, orderData);
            
            case 'cart_expired':
                return this.markCartAsExpired(userId);
            
            default:
                console.log(`Unknown cart recovery webhook event: ${event}`);
                return null;
        }
    }
}

// Singleton instance
const cartRecoverySystem = new CartRecoverySystem();

module.exports = cartRecoverySystem;