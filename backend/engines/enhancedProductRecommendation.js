/**
 * Enhanced Product Recommendation System for Anhance.chat
 * AI-powered recommendations with behavioral analysis and personalization
 */

const botConfig = require('../config/bot_prompts');

class EnhancedProductRecommendation {
    constructor() {
        this.userBehavior = new Map(); // userId -> behavior data
        this.productAnalytics = new Map(); // productId -> analytics data
        this.recommendationCache = new Map(); // cache recommendations
        this.trendingProducts = new Set();
        this.seasonalRecommendations = new Map();
        this.collaborativeData = new Map(); // user similarity data
    }

    /**
     * Get personalized recommendations
     */
    async getPersonalizedRecommendations(userId, options = {}) {
        const {
            limit = 5,
            category = null,
            occasion = null,
            budget = null,
            style = null,
            excludePurchased = true
        } = options;

        // Get user behavior data
        const userBehavior = this.getUserBehavior(userId);
        
        // Generate recommendations using multiple strategies
        const recommendations = [];
        
        // 1. Behavioral recommendations
        const behavioralRecs = await this.getBehavioralRecommendations(userId, userBehavior, limit);
        recommendations.push(...behavioralRecs);

        // 2. Collaborative filtering recommendations
        const collaborativeRecs = await this.getCollaborativeRecommendations(userId, limit);
        recommendations.push(...collaborativeRecs);

        // 3. Content-based recommendations
        const contentBasedRecs = await this.getContentBasedRecommendations(userId, userBehavior, limit);
        recommendations.push(...contentBasedRecs);

        // 4. Trending products
        const trendingRecs = await this.getTrendingRecommendations(limit);
        recommendations.push(...trendingRecs);

        // 5. Seasonal recommendations
        const seasonalRecs = await this.getSeasonalRecommendations(limit);
        recommendations.push(...seasonalRecs);

        // 6. Cross-sell recommendations
        const crossSellRecs = await this.getCrossSellRecommendations(userId, limit);
        recommendations.push(...crossSellRecs);

        // Filter and rank recommendations
        const filteredRecs = this.filterRecommendations(recommendations, {
            category,
            occasion,
            budget,
            style,
            excludePurchased,
            userId
        });

        // Rank recommendations by relevance score
        const rankedRecs = this.rankRecommendations(filteredRecs, userBehavior);

        // Take top recommendations
        const finalRecs = rankedRecs.slice(0, limit);

        // Cache results
        this.cacheRecommendations(userId, finalRecs, options);

        return finalRecs;
    }

    /**
     * Get user behavior data
     */
    getUserBehavior(userId) {
        if (!this.userBehavior.has(userId)) {
            this.userBehavior.set(userId, {
                views: [],
                purchases: [],
                searches: [],
                categories: {},
                brands: {},
                priceRange: { min: 0, max: Infinity },
                style: [],
                colors: [],
                sizes: [],
                occasions: [],
                lastActivity: Date.now(),
                totalSpent: 0,
                averageOrderValue: 0,
                purchaseFrequency: 0,
                preferredTime: 'any',
                deviceType: 'mobile'
            });
        }
        return this.userBehavior.get(userId);
    }

    /**
     * Update user behavior
     */
    updateUserBehavior(userId, action, data) {
        const behavior = this.getUserBehavior(userId);
        const timestamp = Date.now();

        switch (action) {
            case 'view':
                behavior.views.push({
                    productId: data.productId,
                    timestamp,
                    duration: data.duration || 0,
                    source: data.source || 'direct'
                });
                this.updateProductAnalytics(data.productId, 'view', userId);
                break;

            case 'purchase':
                behavior.purchases.push({
                    productId: data.productId,
                    timestamp,
                    price: data.price,
                    quantity: data.quantity || 1,
                    orderId: data.orderId
                });
                behavior.totalSpent += data.price * (data.quantity || 1);
                behavior.averageOrderValue = behavior.totalSpent / behavior.purchases.length;
                behavior.purchaseFrequency++;
                this.updateProductAnalytics(data.productId, 'purchase', userId);
                break;

            case 'search':
                behavior.searches.push({
                    query: data.query,
                    timestamp,
                    results: data.results || 0,
                    clicked: data.clicked || []
                });
                break;

            case 'category_view':
                behavior.categories[data.category] = (behavior.categories[data.category] || 0) + 1;
                break;

            case 'brand_interaction':
                behavior.brands[data.brand] = (behavior.brands[data.brand] || 0) + 1;
                break;
        }

        behavior.lastActivity = timestamp;
    }

    /**
     * Update product analytics
     */
    updateProductAnalytics(productId, action, userId) {
        if (!this.productAnalytics.has(productId)) {
            this.productAnalytics.set(productId, {
                views: 0,
                purchases: 0,
                conversionRate: 0,
                averageViewDuration: 0,
                uniqueViewers: new Set(),
                uniqueBuyers: new Set(),
                lastActivity: Date.now(),
                trendingScore: 0
            });
        }

        const analytics = this.productAnalytics.get(productId);
        
        switch (action) {
            case 'view':
                analytics.views++;
                analytics.uniqueViewers.add(userId);
                analytics.trendingScore += 1;
                break;

            case 'purchase':
                analytics.purchases++;
                analytics.uniqueBuyers.add(userId);
                analytics.conversionRate = analytics.purchases / analytics.views;
                analytics.trendingScore += 10; // Purchases weigh more
                break;
        }

        analytics.lastActivity = Date.now();
        this.updateTrendingProducts();
    }

    /**
     * Get behavioral recommendations
     */
    async getBehavioralRecommendations(userId, userBehavior, limit) {
        const recommendations = [];
        
        // Based on purchase history
        if (userBehavior.purchases.length > 0) {
            const recentPurchases = userBehavior.purchases.slice(-5);
            for (const purchase of recentPurchases) {
                const similarProducts = await this.findSimilarProducts(purchase.productId, limit / 2);
                recommendations.push(...similarProducts);
            }
        }

        // Based on viewing history
        if (userBehavior.views.length > 0) {
            const recentViews = userBehavior.views.slice(-10);
            for (const view of recentViews) {
                if (!userBehavior.purchases.some(p => p.productId === view.productId)) {
                    const similarProducts = await this.findSimilarProducts(view.productId, 2);
                    recommendations.push(...similarProducts);
                }
            }
        }

        // Based on category preferences
        const topCategories = Object.entries(userBehavior.categories)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 3)
            .map(([category]) => category);

        for (const category of topCategories) {
            const categoryProducts = await this.getProductsByCategory(category, 3);
            recommendations.push(...categoryProducts);
        }

        return recommendations.map(product => ({
            ...product,
            recommendationType: 'behavioral',
            score: this.calculateBehavioralScore(product, userBehavior)
        }));
    }

    /**
     * Get collaborative recommendations
     */
    async getCollaborativeRecommendations(userId, limit) {
        const similarUsers = await this.findSimilarUsers(userId);
        const recommendations = [];

        for (const similarUser of similarUsers) {
            const userBehavior = this.getUserBehavior(similarUser.userId);
            const purchasedProducts = userBehavior.purchases
                .filter(p => !this.hasUserPurchased(userId, p.productId))
                .slice(0, 2);

            for (const purchase of purchasedProducts) {
                const product = await this.getProductById(purchase.productId);
                if (product) {
                    recommendations.push({
                        ...product,
                        recommendationType: 'collaborative',
                        score: similarUser.similarity * 0.8,
                        reason: `People similar to you also bought this`
                    });
                }
            }
        }

        return recommendations;
    }

    /**
     * Get content-based recommendations
     */
    async getContentBasedRecommendations(userId, userBehavior, limit) {
        const recommendations = [];
        
        // Based on preferred attributes
        const preferredColors = userBehavior.colors.slice(0, 3);
        const preferredStyles = userBehavior.style.slice(0, 3);
        const preferredSizes = userBehavior.sizes.slice(0, 3);

        // Find products matching user preferences
        const matchingProducts = await this.findProductsByAttributes({
            colors: preferredColors,
            styles: preferredStyles,
            sizes: preferredSizes
        }, limit);

        return matchingProducts.map(product => ({
            ...product,
            recommendationType: 'content_based',
            score: this.calculateContentScore(product, userBehavior),
            reason: `Matches your preferred ${this.getMatchingAttributes(product, userBehavior).join(', ')}`
        }));
    }

    /**
     * Get trending recommendations
     */
    async getTrendingRecommendations(limit) {
        const trendingProducts = Array.from(this.trendingProducts)
            .sort((a, b) => b.trendingScore - a.trendingScore)
            .slice(0, limit);

        return trendingProducts.map(product => ({
            ...product,
            recommendationType: 'trending',
            score: product.trendingScore * 0.9,
            reason: 'Trending now'
        }));
    }

    /**
     * Get seasonal recommendations
     */
    async getSeasonalRecommendations(limit) {
        const currentSeason = this.getCurrentSeason();
        const seasonalProducts = this.seasonalRecommendations.get(currentSeason) || [];

        return seasonalProducts.slice(0, limit).map(product => ({
            ...product,
            recommendationType: 'seasonal',
            score: 0.85,
            reason: `Perfect for ${currentSeason}`
        }));
    }

    /**
     * Get cross-sell recommendations
     */
    async getCrossSellRecommendations(userId, limit) {
        const userBehavior = this.getUserBehavior(userId);
        const recommendations = [];

        // Get recently purchased products
        const recentPurchases = userBehavior.purchases.slice(-3);

        for (const purchase of recentPurchases) {
            const crossSellProducts = await this.findCrossSellProducts(purchase.productId, 2);
            recommendations.push(...crossSellProducts);
        }

        return recommendations.map(product => ({
            ...product,
            recommendationType: 'cross_sell',
            score: 0.75,
            reason: 'Goes well with your recent purchase'
        }));
    }

    /**
     * Filter recommendations based on criteria
     */
    filterRecommendations(recommendations, filters) {
        return recommendations.filter(product => {
            // Filter by category
            if (filters.category && product.category !== filters.category) {
                return false;
            }

            // Filter by budget
            if (filters.budget && product.price > filters.budget) {
                return false;
            }

            // Filter by style
            if (filters.style && !product.style?.includes(filters.style)) {
                return false;
            }

            // Filter out purchased items
            if (filters.excludePurchased && this.hasUserPurchased(filters.userId, product.id)) {
                return false;
            }

            return true;
        });
    }

    /**
     * Rank recommendations by relevance score
     */
    rankRecommendations(recommendations, userBehavior) {
        return recommendations
            .sort((a, b) => {
                // Primary sort by score
                if (a.score !== b.score) {
                    return b.score - a.score;
                }

                // Secondary sort by trending score
                const aAnalytics = this.productAnalytics.get(a.id) || { trendingScore: 0 };
                const bAnalytics = this.productAnalytics.get(b.id) || { trendingScore: 0 };
                return bAnalytics.trendingScore - aAnalytics.trendingScore;
            })
            .slice(0, botConfig.advanced.recommendations.max_results);
    }

    /**
     * Cache recommendations
     */
    cacheRecommendations(userId, recommendations, options) {
        const cacheKey = `${userId}-${JSON.stringify(options)}`;
        this.recommendationCache.set(cacheKey, {
            recommendations,
            timestamp: Date.now(),
            expires: Date.now() + 30 * 60 * 1000 // 30 minutes
        });
    }

    /**
     * Get cached recommendations
     */
    getCachedRecommendations(userId, options) {
        const cacheKey = `${userId}-${JSON.stringify(options)}`;
        const cached = this.recommendationCache.get(cacheKey);
        
        if (cached && cached.expires > Date.now()) {
            return cached.recommendations;
        }
        
        return null;
    }

    /**
     * Calculate behavioral score
     */
    calculateBehavioralScore(product, userBehavior) {
        let score = 0;

        // Based on category preference
        if (userBehavior.categories[product.category]) {
            score += userBehavior.categories[product.category] * 0.3;
        }

        // Based on brand preference
        if (userBehavior.brands[product.brand]) {
            score += userBehavior.brands[product.brand] * 0.2;
        }

        // Based on price range preference
        if (product.price >= userBehavior.priceRange.min && product.price <= userBehavior.priceRange.max) {
            score += 0.2;
        }

        return Math.min(score, 1);
    }

    /**
     * Calculate content-based score
     */
    calculateContentScore(product, userBehavior) {
        let score = 0;
        let matchingAttributes = 0;

        // Color matching
        if (product.colors && userBehavior.colors.length > 0) {
            const colorMatches = product.colors.filter(color => 
                userBehavior.colors.includes(color.toLowerCase())
            ).length;
            score += (colorMatches / userBehavior.colors.length) * 0.4;
            if (colorMatches > 0) matchingAttributes++;
        }

        // Style matching
        if (product.style && userBehavior.style.length > 0) {
            const styleMatches = product.style.filter(style => 
                userBehavior.style.includes(style.toLowerCase())
            ).length;
            score += (styleMatches / userBehavior.style.length) * 0.4;
            if (styleMatches > 0) matchingAttributes++;
        }

        // Size matching
        if (product.sizes && userBehavior.sizes.length > 0) {
            const sizeMatches = product.sizes.filter(size => 
                userBehavior.sizes.includes(size)
            ).length;
            score += (sizeMatches / userBehavior.sizes.length) * 0.2;
            if (sizeMatches > 0) matchingAttributes++;
        }

        return Math.min(score, 1);
    }

    /**
     * Update trending products
     */
    updateTrendingProducts() {
        const trending = Array.from(this.productAnalytics.entries())
            .sort(([,a], [,b]) => b.trendingScore - a.trendingScore)
            .slice(0, 20)
            .map(([productId]) => productId);

        this.trendingProducts = new Set(trending);
    }

    /**
     * Get current season
     */
    getCurrentSeason() {
        const month = new Date().getMonth();
        if (month >= 2 && month <= 4) return 'spring';
        if (month >= 5 && month <= 7) return 'summer';
        if (month >= 8 && month <= 10) return 'autumn';
        return 'winter';
    }

    /**
     * Helper methods (to be implemented based on your product database)
     */
    async findSimilarProducts(productId, limit) {
        // Implement similarity search based on product attributes
        return [];
    }

    async findSimilarUsers(userId) {
        // Implement user similarity based on behavior patterns
        return [];
    }

    async getProductsByCategory(category, limit) {
        // Implement category-based product retrieval
        return [];
    }

    async findProductsByAttributes(attributes, limit) {
        // Implement attribute-based product search
        return [];
    }

    async getProductById(productId) {
        // Implement single product retrieval
        return null;
    }

    async findCrossSellProducts(productId, limit) {
        // Implement cross-sell product discovery
        return [];
    }

    hasUserPurchased(userId, productId) {
        const behavior = this.getUserBehavior(userId);
        return behavior.purchases.some(p => p.productId === productId);
    }

    getMatchingAttributes(product, userBehavior) {
        const matching = [];
        
        if (product.colors && userBehavior.colors.length > 0) {
            const colorMatches = product.colors.filter(color => 
                userBehavior.colors.includes(color.toLowerCase())
            );
            if (colorMatches.length > 0) matching.push('colors');
        }

        if (product.style && userBehavior.style.length > 0) {
            const styleMatches = product.style.filter(style => 
                userBehavior.style.includes(style.toLowerCase())
            );
            if (styleMatches.length > 0) matching.push('styles');
        }

        return matching;
    }

    /**
     * Get recommendation analytics
     */
    getRecommendationAnalytics() {
        const totalUsers = this.userBehavior.size;
        const totalProducts = this.productAnalytics.size;
        const activeRecommendations = this.recommendationCache.size;

        const recommendationTypes = {
            behavioral: 0,
            collaborative: 0,
            content_based: 0,
            trending: 0,
            seasonal: 0,
            cross_sell: 0
        };

        for (const [, cached] of this.recommendationCache) {
            for (const rec of cached.recommendations) {
                if (rec.recommendationType) {
                    recommendationTypes[rec.recommendationType]++;
                }
            }
        }

        return {
            totalUsers,
            totalProducts,
            activeRecommendations,
            recommendationTypes,
            trendingProducts: this.trendingProducts.size,
            seasonalRecommendations: this.seasonalRecommendations.size
        };
    }
}

// Singleton instance
const enhancedProductRecommendation = new EnhancedProductRecommendation();

module.exports = enhancedProductRecommendation;