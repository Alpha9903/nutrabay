/**
 * Enhanced Support Ticket Automation for Anhance.chat
 * Automated ticket creation, categorization, and escalation system
 */

const botConfig = require('../config/bot_prompts');

class SupportTicketAutomation {
    constructor() {
        this.activeTickets = new Map(); // ticketId -> ticket data
        this.userTickets = new Map(); // userId -> array of ticketIds
        this.escalationJobs = new Map(); // ticketId -> escalation timeout
        this.ticketCounter = 1000; // Starting ticket number
        this.autoResponseTemplates = this.initializeAutoResponseTemplates();
    }

    /**
     * Initialize auto-response templates
     */
    initializeAutoResponseTemplates() {
        return {
            order_issue: {
                immediate: "I've received your order-related concern. I'm checking your order details and will provide an update within 30 minutes. 📦",
                followup: "I'm still investigating your order issue. I'll have a detailed response for you within the next hour. Thank you for your patience. ⏰",
                escalation: "Your order issue has been escalated to our senior support team. They'll contact you directly within 2 hours. 📞"
            },
            product_inquiry: {
                immediate: "Thank you for your product question! I'm gathering detailed information about this item and will respond with complete specifications within 15 minutes. 🔍",
                followup: "I'm compiling comprehensive product details including availability, sizing, and alternatives. You'll receive this information shortly. 📋",
                escalation: "Your product inquiry has been forwarded to our product specialists who will provide expert guidance within 1 hour. 👨‍💼"
            },
            shipping_problem: {
                immediate: "I understand your shipping concern. I'm tracking your package and will provide the latest shipping status within 20 minutes. 🚚",
                followup: "I'm coordinating with our shipping partners to resolve this issue. I'll update you on the progress within the next hour. 📍",
                escalation: "Your shipping issue has been escalated to our logistics team. They'll provide a resolution plan within 2 hours. 🚛"
            },
            payment_issue: {
                immediate: "I've noted your payment concern. I'm reviewing your transaction details and will provide assistance within 15 minutes. 💳",
                followup: "I'm working with our payment processing team to resolve this issue. You'll receive an update within 30 minutes. 💰",
                escalation: "Your payment issue has been escalated to our billing department. They'll contact you within 1 hour with a resolution. 🏦"
            },
            technical_support: {
                immediate: "I've logged your technical issue. I'm diagnosing the problem and will provide troubleshooting steps within 30 minutes. 🔧",
                followup: "I'm conducting a deeper technical analysis. I'll provide advanced solutions or workarounds within the next hour. 💻",
                escalation: "Your technical issue has been escalated to our IT support team. They'll provide specialized assistance within 2 hours. 👨‍💻"
            },
            general_inquiry: {
                immediate: "Thank you for reaching out! I've received your inquiry and will provide a comprehensive response within 30 minutes. 📬",
                followup: "I'm researching your question thoroughly to ensure I provide accurate and complete information. You'll hear back shortly. 📖",
                escalation: "Your inquiry has been forwarded to the appropriate department. They'll provide expert assistance within 2 hours. 🎯"
            }
        };
    }

    /**
     * Create support ticket with automatic categorization
     */
    async createTicket(userId, issueData) {
        const ticketId = `ANH-${++this.ticketCounter}`;
        const timestamp = Date.now();
        
        // Analyze and categorize the issue
        const category = await this.categorizeIssue(issueData.message);
        const priority = this.calculatePriority(issueData);
        const sentiment = await this.analyzeSentiment(issueData.message);
        
        const ticket = {
            ticketId,
            userId,
            category,
            priority,
            sentiment,
            status: 'open',
            createdAt: timestamp,
            updatedAt: timestamp,
            subject: issueData.subject || this.generateSubject(issueData.message),
            description: issueData.message,
            userInfo: {
                name: issueData.userName,
                email: issueData.userEmail,
                phone: issueData.userPhone,
                orderId: issueData.orderId,
                productId: issueData.productId
            },
            metadata: {
                source: issueData.source || 'chat',
                platform: issueData.platform || 'website',
                language: issueData.language || 'en'
            },
            autoResponses: [],
            assignedAgent: null,
            escalationLevel: 0,
            resolutionNotes: [],
            customerSatisfaction: null
        };

        // Store ticket
        this.activeTickets.set(ticketId, ticket);
        
        // Track user's tickets
        if (!this.userTickets.has(userId)) {
            this.userTickets.set(userId, []);
        }
        this.userTickets.get(userId).push(ticketId);

        // Send immediate auto-response
        await this.sendAutoResponse(ticketId, 'immediate');

        // Schedule escalation if needed
        this.scheduleEscalation(ticketId);

        // Log ticket creation
        console.log(`Support ticket created: ${ticketId} for user ${userId} - Category: ${category}, Priority: ${priority}`);

        return ticket;
    }

    /**
     * Automatically categorize the issue using AI
     */
    async categorizeIssue(message) {
        const categories = botConfig.advanced.support_tickets.categories;
        
        // Simple keyword-based categorization (can be enhanced with ML)
        const lowerMessage = message.toLowerCase();
        
        if (lowerMessage.includes('order') || lowerMessage.includes('purchase') || lowerMessage.includes('buy')) {
            return 'order';
        } else if (lowerMessage.includes('product') || lowerMessage.includes('item') || lowerMessage.includes('quality')) {
            return 'product';
        } else if (lowerMessage.includes('ship') || lowerMessage.includes('delivery') || lowerMessage.includes('package')) {
            return 'shipping';
        } else if (lowerMessage.includes('payment') || lowerMessage.includes('pay') || lowerMessage.includes('refund')) {
            return 'payment';
        } else if (lowerMessage.includes('error') || lowerMessage.includes('bug') || lowerMessage.includes('technical')) {
            return 'technical';
        } else {
            return 'other';
        }
    }

    /**
     * Calculate priority based on issue data
     */
    calculatePriority(issueData) {
        let priority = 'medium';
        
        // High priority indicators
        if (issueData.urgent || issueData.emergency) {
            priority = 'high';
        }
        
        // Check for high-value orders
        if (issueData.orderValue && issueData.orderValue > 5000) {
            priority = 'high';
        }
        
        // Check for repeat issues
        const userTickets = this.userTickets.get(issueData.userId) || [];
        if (userTickets.length > 2) {
            priority = 'high';
        }
        
        // Sentiment analysis (negative sentiment = higher priority)
        if (issueData.sentiment && issueData.sentiment === 'very_negative') {
            priority = 'high';
        }
        
        return priority;
    }

    /**
     * Analyze sentiment of the message
     */
    async analyzeSentiment(message) {
        // Simple sentiment analysis (can be enhanced with AI)
        const negativeWords = ['angry', 'frustrated', 'terrible', 'awful', 'worst', 'hate', 'disappointed', 'useless', 'broken', 'wrong'];
        const positiveWords = ['great', 'excellent', 'good', 'happy', 'satisfied', 'love', 'perfect', 'amazing'];
        
        const lowerMessage = message.toLowerCase();
        let negativeScore = 0;
        let positiveScore = 0;
        
        negativeWords.forEach(word => {
            if (lowerMessage.includes(word)) negativeScore++;
        });
        
        positiveWords.forEach(word => {
            if (lowerMessage.includes(word)) positiveScore++;
        });
        
        if (negativeScore > positiveScore) {
            return negativeScore > 2 ? 'very_negative' : 'negative';
        } else if (positiveScore > negativeScore) {
            return 'positive';
        } else {
            return 'neutral';
        }
    }

    /**
     * Generate subject from message
     */
    generateSubject(message) {
        // Extract first 50 characters and add ellipsis if longer
        const subject = message.substring(0, 50);
        return message.length > 50 ? `${subject}...` : subject;
    }

    /**
     * Send auto-response based on category and timing
     */
    async sendAutoResponse(ticketId, responseType) {
        const ticket = this.activeTickets.get(ticketId);
        if (!ticket) return;

        const templates = this.autoResponseTemplates[ticket.category] || this.autoResponseTemplates.general_inquiry;
        const response = templates[responseType];
        
        if (!response) return;

        const autoResponse = {
            type: responseType,
            message: response,
            timestamp: Date.now(),
            automated: true
        };

        ticket.autoResponses.push(autoResponse);
        ticket.updatedAt = Date.now();

        // Deliver the auto-response (integrate with your messaging system)
        await this.deliverAutoResponse(ticket.userId, autoResponse);

        console.log(`Auto-response sent for ticket ${ticketId}: ${responseType}`);
        return autoResponse;
    }

    /**
     * Deliver auto-response through messaging system
     */
    async deliverAutoResponse(userId, autoResponse) {
        // Integrate with your existing messaging system
        console.log(`Auto-response to user ${userId}: ${autoResponse.message}`);
        return true;
    }

    /**
     * Schedule ticket escalation
     */
    scheduleEscalation(ticketId) {
        const ticket = this.activeTickets.get(ticketId);
        if (!ticket || ticket.status !== 'open') return;

        // Clear existing escalation job
        if (this.escalationJobs.has(ticketId)) {
            clearTimeout(this.escalationJobs.get(ticketId));
        }

        const escalationTime = botConfig.advanced.support_tickets.escalation_time;
        
        const job = setTimeout(() => {
            this.escalateTicket(ticketId);
        }, escalationTime);

        this.escalationJobs.set(ticketId, job);
    }

    /**
     * Escalate ticket to next level
     */
    async escalateTicket(ticketId) {
        const ticket = this.activeTickets.get(ticketId);
        if (!ticket || ticket.status !== 'open') return;

        ticket.escalationLevel++;
        ticket.priority = 'high';
        ticket.updatedAt = Date.now();

        // Send escalation auto-response
        await this.sendAutoResponse(ticketId, 'escalation');

        // Assign to senior agent (in real implementation)
        ticket.assignedAgent = `senior-agent-${ticket.escalationLevel}`;

        console.log(`Ticket ${ticketId} escalated to level ${ticket.escalationLevel}`);

        // Notify escalation team (in real implementation)
        await this.notifyEscalationTeam(ticket);

        return ticket;
    }

    /**
     * Notify escalation team
     */
    async notifyEscalationTeam(ticket) {
        console.log(`Escalation notification: Ticket ${ticket.ticketId} requires immediate attention`);
        // Implement actual notification system (email, Slack, etc.)
        return true;
    }

    /**
     * Update ticket status
     */
    async updateTicketStatus(ticketId, status, notes = '') {
        const ticket = this.activeTickets.get(ticketId);
        if (!ticket) return null;

        const oldStatus = ticket.status;
        ticket.status = status;
        ticket.updatedAt = Date.now();

        if (notes) {
            ticket.resolutionNotes.push({
                note: notes,
                timestamp: Date.now(),
                by: 'system'
            });
        }

        // Handle status-specific actions
        switch (status) {
            case 'resolved':
                await this.handleTicketResolution(ticket);
                break;
            case 'closed':
                await this.handleTicketClosure(ticket);
                break;
            case 'pending':
                // Clear escalation job
                if (this.escalationJobs.has(ticketId)) {
                    clearTimeout(this.escalationJobs.get(ticketId));
                    this.escalationJobs.delete(ticketId);
                }
                break;
        }

        console.log(`Ticket ${ticketId} status updated: ${oldStatus} -> ${status}`);
        return ticket;
    }

    /**
     * Handle ticket resolution
     */
    async handleTicketResolution(ticket) {
        // Send resolution message
        const resolutionMessage = botConfig.advanced.support_tickets.resolution_message;
        await this.deliverAutoResponse(ticket.userId, {
            type: 'resolution',
            message: resolutionMessage,
            timestamp: Date.now(),
            automated: true
        });

        // Request customer satisfaction feedback
        setTimeout(() => {
            this.requestCustomerSatisfaction(ticket.ticketId);
        }, 24 * 60 * 60 * 1000); // 24 hours later
    }

    /**
     * Handle ticket closure
     */
    async handleTicketClosure(ticket) {
        // Clear escalation job
        if (this.escalationJobs.has(ticket.ticketId)) {
            clearTimeout(this.escalationJobs.get(ticket.ticketId));
            this.escalationJobs.delete(ticket.ticketId);
        }

        // Archive ticket (in real implementation)
        console.log(`Ticket ${ticket.ticketId} closed and archived`);
    }

    /**
     * Request customer satisfaction feedback
     */
    async requestCustomerSatisfaction(ticketId) {
        const ticket = this.activeTickets.get(ticketId);
        if (!ticket) return;

        const satisfactionMessage = "How was your support experience? Please rate us 1-5 (5 being excellent) so we can improve our service! 🌟";
        
        await this.deliverAutoResponse(ticket.userId, {
            type: 'satisfaction',
            message: satisfactionMessage,
            timestamp: Date.now(),
            automated: true
        });
    }

    /**
     * Record customer satisfaction
     */
    async recordCustomerSatisfaction(ticketId, rating) {
        const ticket = this.activeTickets.get(ticketId);
        if (!ticket) return null;

        ticket.customerSatisfaction = {
            rating: parseInt(rating),
            timestamp: Date.now()
        };

        console.log(`Customer satisfaction recorded for ticket ${ticketId}: ${rating}/5`);
        return ticket;
    }

    /**
     * Get ticket statistics
     */
    getTicketStats() {
        const stats = {
            totalTickets: this.activeTickets.size,
            openTickets: 0,
            pendingTickets: 0,
            resolvedTickets: 0,
            closedTickets: 0,
            escalatedTickets: 0,
            averageResolutionTime: 0,
            customerSatisfaction: 0
        };

        let totalResolutionTime = 0;
        let resolvedCount = 0;
        let totalSatisfaction = 0;
        let satisfactionCount = 0;

        for (const [ticketId, ticket] of this.activeTickets) {
            switch (ticket.status) {
                case 'open':
                    stats.openTickets++;
                    break;
                case 'pending':
                    stats.pendingTickets++;
                    break;
                case 'resolved':
                    stats.resolvedTickets++;
                    resolvedCount++;
                    if (ticket.resolvedAt && ticket.createdAt) {
                        totalResolutionTime += (ticket.resolvedAt - ticket.createdAt);
                    }
                    break;
                case 'closed':
                    stats.closedTickets++;
                    break;
            }

            if (ticket.escalationLevel > 0) {
                stats.escalatedTickets++;
            }

            if (ticket.customerSatisfaction) {
                totalSatisfaction += ticket.customerSatisfaction.rating;
                satisfactionCount++;
            }
        }

        stats.averageResolutionTime = resolvedCount > 0 ? Math.round(totalResolutionTime / resolvedCount / 1000 / 60) : 0; // minutes
        stats.customerSatisfaction = satisfactionCount > 0 ? Math.round((totalSatisfaction / satisfactionCount) * 10) / 10 : 0;

        return stats;
    }

    /**
     * Get user tickets
     */
    getUserTickets(userId) {
        const ticketIds = this.userTickets.get(userId) || [];
        return ticketIds.map(ticketId => this.activeTickets.get(ticketId)).filter(Boolean);
    }

    /**
     * Process support webhook
     */
    async processWebhook(webhookData) {
        const { event, ticketId, userId, data } = webhookData;

        switch (event) {
            case 'ticket_created':
                return await this.createTicket(userId, data);
            
            case 'ticket_updated':
                return await this.updateTicketStatus(ticketId, data.status, data.notes);
            
            case 'ticket_escalated':
                return await this.escalateTicket(ticketId);
            
            case 'satisfaction_recorded':
                return await this.recordCustomerSatisfaction(ticketId, data.rating);
            
            default:
                console.log(`Unknown support webhook event: ${event}`);
                return null;
        }
    }
}

// Singleton instance
const supportTicketAutomation = new SupportTicketAutomation();

module.exports = supportTicketAutomation;