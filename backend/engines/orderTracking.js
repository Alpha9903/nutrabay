/**
 * Order Tracking System for Anhance.chat
 * Real-time order tracking with multi-carrier support and proactive notifications
 */

const botConfig = require('../config/bot_prompts');

class OrderTrackingSystem {
    constructor() {
        this.trackedOrders = new Map(); // orderId -> order tracking data
        this.userOrders = new Map(); // userId -> array of orderIds
        this.trackingJobs = new Map(); // orderId -> tracking update jobs
        this.carriers = this.initializeCarriers();
        this.statusTemplates = this.initializeStatusTemplates();
    }

    /**
     * Initialize supported carriers
     */
    initializeCarriers() {
        return {
            fedex: {
                name: 'FedEx',
                trackingUrl: 'https://www.fedex.com/track?tracknumber={tracking_number}',
                apiEndpoint: 'https://apis.fedex.com/track/v1/trackingnumbers',
                webhookSupport: true
            },
            ups: {
                name: 'UPS',
                trackingUrl: 'https://www.ups.com/track?tracknum={tracking_number}',
                apiEndpoint: 'https://onlinetools.ups.com/track/v1/details/{tracking_number}',
                webhookSupport: true
            },
            dhl: {
                name: 'DHL',
                trackingUrl: 'https://www.dhl.com/en/express/tracking.html?AWB={tracking_number}',
                apiEndpoint: 'https://api-eu.dhl.com/track/shipments',
                webhookSupport: true
            },
            usps: {
                name: 'USPS',
                trackingUrl: 'https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1={tracking_number}',
                apiEndpoint: 'https://secure.shippingapis.com/ShippingAPI.dll',
                webhookSupport: false
            },
            india_post: {
                name: 'India Post',
                trackingUrl: 'https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx',
                apiEndpoint: 'https://www.indiapost.gov.in/api/tracking',
                webhookSupport: false
            }
        };
    }

    /**
     * Initialize status templates
     */
    initializeStatusTemplates() {
        return {
            order_placed: {
                message: "🎉 Great news! Your order has been confirmed and is being prepared for shipment.",
                emoji: "📦",
                nextUpdate: 24 * 60 * 60 * 1000 // 24 hours
            },
            processing: {
                message: "Your order is being processed and will be shipped soon.",
                emoji: "⚙️",
                nextUpdate: 12 * 60 * 60 * 1000 // 12 hours
            },
            shipped: {
                message: "🚚 Your order has been shipped! Track it here: {tracking_url}",
                emoji: "🚚",
                nextUpdate: 6 * 60 * 60 * 1000 // 6 hours
            },
            in_transit: {
                message: "Your package is on its way! Current location: {location}",
                emoji: "✈️",
                nextUpdate: 6 * 60 * 60 * 1000 // 6 hours
            },
            out_for_delivery: {
                message: "🎁 Exciting! Your package is out for delivery and will arrive today!",
                emoji: "🚚",
                nextUpdate: 2 * 60 * 60 * 1000 // 2 hours
            },
            delivered: {
                message: "🎉 Your order has been delivered! We hope you love your purchase.",
                emoji: "🏠",
                nextUpdate: null // No more updates
            },
            failed_delivery: {
                message: "Delivery attempt failed. Don't worry, they'll try again tomorrow. 📅",
                emoji: "❌",
                nextUpdate: 24 * 60 * 60 * 1000 // 24 hours
            },
            delayed: {
                message: "Your order is experiencing a delay. We apologize for the inconvenience and are working to resolve this.",
                emoji: "⏰",
                nextUpdate: 12 * 60 * 60 * 1000 // 12 hours
            },
            exception: {
                message: "There's an issue with your shipment. Our team is investigating and will update you shortly.",
                emoji: "⚠️",
                nextUpdate: 6 * 60 * 60 * 1000 // 6 hours
            }
        };
    }

    /**
     * Add order for tracking
     */
    async addOrderForTracking(orderData) {
        const { orderId, userId, trackingNumber, carrier, orderDetails } = orderData;
        
        if (!orderId || !userId || !trackingNumber || !carrier) {
            throw new Error('Missing required order tracking data');
        }

        // Validate carrier
        if (!this.carriers[carrier]) {
            throw new Error(`Unsupported carrier: ${carrier}`);
        }

        const trackingInfo = {
            orderId,
            userId,
            trackingNumber,
            carrier,
            orderDetails: orderDetails || {},
            status: 'order_placed',
            trackingHistory: [],
            lastUpdate: Date.now(),
            estimatedDelivery: null,
            currentLocation: null,
            notifications: {
                shipped: false,
                out_for_delivery: false,
                delivered: false,
                delayed: false,
                failed_delivery: false
            },
            proactiveNotifications: true
        };

        // Store order tracking info
        this.trackedOrders.set(orderId, trackingInfo);
        
        // Track user's orders
        if (!this.userOrders.has(userId)) {
            this.userOrders.set(userId, []);
        }
        this.userOrders.get(userId).push(orderId);

        // Get initial tracking data
        await this.updateTrackingInfo(orderId);

        // Schedule tracking updates
        this.scheduleTrackingUpdates(orderId);

        console.log(`Order tracking added: ${orderId} for user ${userId} with ${carrier} tracking ${trackingNumber}`);
        
        return trackingInfo;
    }

    /**
     * Update tracking information
     */
    async updateTrackingInfo(orderId) {
        const trackingInfo = this.trackedOrders.get(orderId);
        if (!trackingInfo) return null;

        try {
            // Simulate tracking API call (replace with actual carrier APIs)
            const trackingData = await this.fetchTrackingData(
                trackingInfo.trackingNumber, 
                trackingInfo.carrier
            );

            if (trackingData) {
                // Update tracking info
                const oldStatus = trackingInfo.status;
                trackingInfo.status = trackingData.status;
                trackingInfo.currentLocation = trackingData.location;
                trackingInfo.estimatedDelivery = trackingData.estimatedDelivery;
                trackingInfo.lastUpdate = Date.now();

                // Add to tracking history
                trackingInfo.trackingHistory.push({
                    status: trackingData.status,
                    location: trackingData.location,
                    timestamp: Date.now(),
                    details: trackingData.details
                });

                // Send notifications for important status changes
                if (oldStatus !== trackingData.status) {
                    await this.sendStatusUpdateNotification(orderId, oldStatus, trackingData.status);
                }

                // Handle special status notifications
                await this.handleSpecialStatusNotifications(orderId, trackingData.status);

                console.log(`Tracking updated for order ${orderId}: ${oldStatus} -> ${trackingData.status}`);
            }

            return trackingInfo;
        } catch (error) {
            console.error(`Error updating tracking for order ${orderId}:`, error);
            return null;
        }
    }

    /**
     * Fetch tracking data from carrier (simulated)
     */
    async fetchTrackingData(trackingNumber, carrier) {
        // This is a simulated response - replace with actual carrier API calls
        const carriers = Object.keys(this.carriers);
        const statuses = Object.keys(this.statusTemplates);
        
        // Simulate random status progression
        const currentTime = Date.now();
        const mockData = {
            trackingNumber,
            carrier,
            status: statuses[Math.floor(Math.random() * statuses.length)],
            location: this.generateMockLocation(),
            estimatedDelivery: new Date(currentTime + Math.random() * 7 * 24 * 60 * 60 * 1000).toISOString(),
            details: {
                weight: `${Math.floor(Math.random() * 5) + 1}kg`,
                dimensions: `${Math.floor(Math.random() * 50) + 10}x${Math.floor(Math.random() * 50) + 10}x${Math.floor(Math.random() * 30) + 5}cm`,
                service: 'Standard Delivery'
            }
        };

        return mockData;
    }

    /**
     * Generate mock location for simulation
     */
    generateMockLocation() {
        const locations = [
            'Mumbai, India',
            'Delhi, India',
            'Bangalore, India',
            'Chennai, India',
            'Kolkata, India',
            'Hyderabad, India',
            'Pune, India',
            'Ahmedabad, India',
            'New York, USA',
            'Los Angeles, USA',
            'Chicago, USA',
            'London, UK',
            'Paris, France',
            'Tokyo, Japan',
            'Singapore'
        ];
        
        return locations[Math.floor(Math.random() * locations.length)];
    }

    /**
     * Send status update notification
     */
    async sendStatusUpdateNotification(orderId, oldStatus, newStatus) {
        const trackingInfo = this.trackedOrders.get(orderId);
        if (!trackingInfo) return;

        const template = this.statusTemplates[newStatus];
        if (!template) return;

        let message = template.message;
        
        // Replace placeholders
        if (newStatus === 'shipped' && trackingInfo.carrier) {
            const carrier = this.carriers[trackingInfo.carrier];
            const trackingUrl = carrier.trackingUrl.replace('{tracking_number}', trackingInfo.trackingNumber);
            message = message.replace('{tracking_url}', trackingUrl);
        }
        
        if (trackingInfo.currentLocation) {
            message = message.replace('{location}', trackingInfo.currentLocation);
        }

        // Add personalized touch
        message = `Hi! ${message}`;
        
        if (trackingInfo.orderDetails && trackingInfo.orderDetails.customerName) {
            message = `Hi ${trackingInfo.orderDetails.customerName}! ${message.replace('Hi! ', '')}`;
        }

        // Deliver notification (integrate with your messaging system)
        await this.deliverNotification(trackingInfo.userId, {
            type: 'order_status_update',
            orderId: orderId,
            status: newStatus,
            message: message,
            emoji: template.emoji,
            timestamp: Date.now()
        });

        console.log(`Status notification sent for order ${orderId}: ${newStatus}`);
    }

    /**
     * Handle special status notifications
     */
    async handleSpecialStatusNotifications(orderId, status) {
        const trackingInfo = this.trackedOrders.get(orderId);
        if (!trackingInfo) return;

        // Only send once per status
        if (trackingInfo.notifications[status]) return;

        let specialMessage = null;

        switch (status) {
            case 'out_for_delivery':
                specialMessage = "📱 Pro tip: Keep your phone nearby! The delivery person may contact you.";
                trackingInfo.notifications.out_for_delivery = true;
                break;
            
            case 'delivered':
                specialMessage = "💝 We hope you love your purchase! If you have any issues, we're here to help.";
                trackingInfo.notifications.delivered = true;
                
                // Schedule follow-up in 3 days
                setTimeout(() => {
                    this.sendFollowUpMessage(orderId);
                }, 3 * 24 * 60 * 60 * 1000);
                break;
            
            case 'failed_delivery':
                specialMessage = "📞 The delivery person will attempt delivery again tomorrow. You can also contact them directly if needed.";
                trackingInfo.notifications.failed_delivery = true;
                break;
            
            case 'delayed':
                specialMessage = "🎁 As an apology for the delay, here's a 10% discount on your next order: DELAY10";
                trackingInfo.notifications.delayed = true;
                break;
        }

        if (specialMessage) {
            await this.deliverNotification(trackingInfo.userId, {
                type: 'special_notification',
                orderId: orderId,
                status: status,
                message: specialMessage,
                timestamp: Date.now()
            });
        }
    }

    /**
     * Send follow-up message after delivery
     */
    async sendFollowUpMessage(orderId) {
        const trackingInfo = this.trackedOrders.get(orderId);
        if (!trackingInfo) return;

        const followUpMessage = "👋 How's everything with your order? If you need any help or have questions, we're here for you!";
        
        await this.deliverNotification(trackingInfo.userId, {
            type: 'follow_up',
            orderId: orderId,
            message: followUpMessage,
            timestamp: Date.now()
        });
    }

    /**
     * Deliver notification through messaging system
     */
    async deliverNotification(userId, notification) {
        console.log(`Order notification to user ${userId}: ${notification.message}`);
        // Integrate with your existing messaging system
        return true;
    }

    /**
     * Schedule tracking updates
     */
    scheduleTrackingUpdates(orderId) {
        const trackingInfo = this.trackedOrders.get(orderId);
        if (!trackingInfo || !trackingInfo.proactiveNotifications) return;

        // Clear existing job
        if (this.trackingJobs.has(orderId)) {
            clearTimeout(this.trackingJobs.get(orderId));
        }

        const currentStatus = trackingInfo.status;
        const template = this.statusTemplates[currentStatus];
        
        if (!template || !template.nextUpdate) return;

        const job = setTimeout(() => {
            this.updateTrackingInfo(orderId).then(() => {
                // Schedule next update
                this.scheduleTrackingUpdates(orderId);
            });
        }, template.nextUpdate);

        this.trackingJobs.set(orderId, job);
    }

    /**
     * Get order tracking info
     */
    getOrderTracking(orderId) {
        return this.trackedOrders.get(orderId) || null;
    }

    /**
     * Get user orders
     */
    getUserOrders(userId) {
        const orderIds = this.userOrders.get(userId) || [];
        return orderIds.map(orderId => this.trackedOrders.get(orderId)).filter(Boolean);
    }

    /**
     * Get tracking URL for order
     */
    getTrackingUrl(orderId) {
        const trackingInfo = this.trackedOrders.get(orderId);
        if (!trackingInfo) return null;

        const carrier = this.carriers[trackingInfo.carrier];
        if (!carrier) return null;

        return carrier.trackingUrl.replace('{tracking_number}', trackingInfo.trackingNumber);
    }

    /**
     * Enable/disable proactive notifications
     */
    setProactiveNotifications(orderId, enabled) {
        const trackingInfo = this.trackedOrders.get(orderId);
        if (!trackingInfo) return false;

        trackingInfo.proactiveNotifications = enabled;

        if (enabled) {
            this.scheduleTrackingUpdates(orderId);
        } else {
            if (this.trackingJobs.has(orderId)) {
                clearTimeout(this.trackingJobs.get(orderId));
                this.trackingJobs.delete(orderId);
            }
        }

        return true;
    }

    /**
     * Get tracking statistics
     */
    getTrackingStats() {
        const stats = {
            totalTrackedOrders: this.trackedOrders.size,
            activeOrders: 0,
            deliveredOrders: 0,
            delayedOrders: 0,
            averageDeliveryTime: 0,
            onTimeDeliveryRate: 0
        };

        let totalDeliveryTime = 0;
        let deliveredCount = 0;
        let onTimeDeliveries = 0;

        for (const [orderId, trackingInfo] of this.trackedOrders) {
            if (trackingInfo.status !== 'delivered' && trackingInfo.status !== 'cancelled') {
                stats.activeOrders++;
            }

            if (trackingInfo.status === 'delivered') {
                stats.deliveredOrders++;
                deliveredCount++;
                
                // Calculate delivery time (simplified)
                if (trackingInfo.trackingHistory.length > 1) {
                    const firstUpdate = trackingInfo.trackingHistory[0].timestamp;
                    const deliveryUpdate = trackingInfo.trackingHistory.find(h => h.status === 'delivered');
                    if (deliveryUpdate) {
                        const deliveryTime = deliveryUpdate.timestamp - firstUpdate;
                        totalDeliveryTime += deliveryTime;
                        
                        // Check if on-time (simplified logic)
                        if (trackingInfo.estimatedDelivery) {
                            const estimated = new Date(trackingInfo.estimatedDelivery).getTime();
                            const actual = deliveryUpdate.timestamp;
                            if (actual <= estimated + 24 * 60 * 60 * 1000) { // Within 1 day of estimated
                                onTimeDeliveries++;
                            }
                        }
                    }
                }
            }

            if (trackingInfo.status === 'delayed' || trackingInfo.status === 'exception') {
                stats.delayedOrders++;
            }
        }

        stats.averageDeliveryTime = deliveredCount > 0 ? Math.round(totalDeliveryTime / deliveredCount / 1000 / 60 / 60 / 24) : 0; // days
        stats.onTimeDeliveryRate = deliveredCount > 0 ? Math.round((onTimeDeliveries / deliveredCount) * 100) : 0;

        return stats;
    }

    /**
     * Process tracking webhook
     */
    async processWebhook(webhookData) {
        const { event, orderId, trackingData } = webhookData;

        switch (event) {
            case 'order_shipped':
                return await this.addOrderForTracking({
                    orderId,
                    userId: trackingData.userId,
                    trackingNumber: trackingData.trackingNumber,
                    carrier: trackingData.carrier,
                    orderDetails: trackingData.orderDetails
                });
            
            case 'tracking_update':
                return await this.updateTrackingInfo(orderId);
            
            case 'delivery_confirmed':
                const trackingInfo = this.trackedOrders.get(orderId);
                if (trackingInfo) {
                    trackingInfo.status = 'delivered';
                    trackingInfo.trackingHistory.push({
                        status: 'delivered',
                        location: trackingInfo.currentLocation,
                        timestamp: Date.now(),
                        details: { confirmed: true }
                    });
                    await this.sendStatusUpdateNotification(orderId, 'in_transit', 'delivered');
                }
                return trackingInfo;
            
            default:
                console.log(`Unknown tracking webhook event: ${event}`);
                return null;
        }
    }
}

// Singleton instance
const orderTrackingSystem = new OrderTrackingSystem();

module.exports = orderTrackingSystem;