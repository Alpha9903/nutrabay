const DEFAULT_PLAN_NAME = 'Free';

function createSubscriptionManager({ supabase, getBotId }) {
    const FORCE_SUBSCRIPTION_ACTIVE = true;
    if (!supabase) {
        return {
            getUserSubscription: async () => null,
            checkFeatureAccess: async () => ({ allowed: true, reason: 'supabase_unavailable' }),
            incrementUsage: async () => ({ success: false, reason: 'supabase_unavailable' }),
            resetMonthlyUsage: async () => ({ success: false, reason: 'supabase_unavailable' }),
            changeUserPlan: async () => ({ success: false, reason: 'supabase_unavailable' }),
            activateTrial: async () => ({ success: false, reason: 'supabase_unavailable' }),
            listPlans: async () => [],
            listUsers: async () => [],
            listSubscriptions: async () => [],
            getUsage: async () => null
        };
    }

    const nowIso = () => new Date().toISOString();
    const getMonthYear = (d = new Date()) => ({
        month: d.getMonth() + 1,
        year: d.getFullYear()
    });

    const isSubscriptionActive = (sub) => {
        if (FORCE_SUBSCRIPTION_ACTIVE) return true;
        if (!sub || typeof sub !== 'object') return false;
        const status = typeof sub.status === 'string' ? sub.status.toLowerCase() : '';
        return status === 'active' || status === 'trial';
    };

    const getPlanById = async (planId) => {
        if (!planId) return null;
        const { data, error } = await supabase
            .from('plans')
            .select('*')
            .eq('id', planId)
            .maybeSingle();
        if (error) return null;
        return data || null;
    };

    const getPlanByName = async (name) => {
        const { data, error } = await supabase
            .from('plans')
            .select('*')
            .eq('name', name)
            .maybeSingle();
        if (error) return null;
        return data || null;
    };

    const getActiveSubscriptionRow = async (userId) => {
        if (!userId) return null;
        const { data, error } = await supabase
            .from('user_subscriptions')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(1);
        if (error || !Array.isArray(data) || !data.length) return null;
        const active = data.find(isSubscriptionActive);
        return active || data[0] || null;
    };

    const ensureDefaultSubscription = async (userId) => {
        if (!userId) return null;
        const existing = await getActiveSubscriptionRow(userId);
        if (existing && isSubscriptionActive(existing)) {
            const plan = await getPlanById(existing.plan_id);
            return { subscription: existing, plan };
        }
        const freePlan = await getPlanByName(DEFAULT_PLAN_NAME);
        if (!freePlan || !freePlan.id) return null;
        const payload = {
            user_id: userId,
            plan_id: freePlan.id,
            status: 'active',
            created_at: nowIso(),
            razorpay_customer_id: null,
            razorpay_subscription_id: null
        };
        const { data, error } = await supabase
            .from('user_subscriptions')
            .insert(payload)
            .select('*')
            .limit(1);
        if (error) return null;
        const subscription = Array.isArray(data) ? data[0] : null;
        return { subscription, plan: freePlan };
    };

    const getUserSubscription = async (userId) => {
        const ensured = await ensureDefaultSubscription(userId);
        if (!ensured || !ensured.subscription) return null;
        return ensured;
    };

    const getUsageRecord = async (userId, botId, month, year) => {
        if (!userId) return null;
        const { data, error } = await supabase
            .from('usage')
            .select('*')
            .eq('user_id', userId)
            .eq('month', month)
            .eq('year', year)
            .limit(1);
        if (!error && Array.isArray(data) && data.length) {
            return data[0];
        }
        const payload = {
            user_id: userId,
            bots_created: 0,
            messages_used: 0,
            month,
            year
        };
        const { data: created, error: createError } = await supabase
            .from('usage')
            .insert(payload)
            .select('*')
            .limit(1);
        if (createError) return null;
        return Array.isArray(created) ? created[0] : null;
    };

    const incrementUsage = async ({ userId, botId, messages = 0, tokens = 0, botsCreated = 0 }) => {
        if (!userId) return { success: false, reason: 'missing_user' };
        const { month, year } = getMonthYear();
        const record = await getUsageRecord(userId, botId, month, year);
        if (!record) return { success: false, reason: 'usage_init_failed' };
        const nextMessages = (Number(record.messages_used) || 0) + (Number(messages) || 0);
        const nextBotsCreated = (Number(record.bots_created) || 0) + (Number(botsCreated) || 0);
        const { error } = await supabase
            .from('usage')
            .update({
                messages_used: nextMessages,
                bots_created: nextBotsCreated
            })
            .eq('id', record.id);
        if (error) return { success: false, reason: error.message || 'update_failed' };
        return { success: true, messages_used: nextMessages, bots_created: nextBotsCreated };
    };

    const countUserBots = async (userId) => {
        if (!userId) return null;
        const botId = getBotId ? getBotId() : null;
        const tryColumn = async (column) => {
            const query = supabase.from('bots').select('id', { count: 'exact', head: true }).eq(column, userId);
            if (botId) query.eq('bot_id', botId);
            const { count, error } = await query;
            if (error) return null;
            return typeof count === 'number' ? count : null;
        };
        const byOwner = await tryColumn('owner_user_id');
        if (byOwner != null) return byOwner;
        const byUser = await tryColumn('user_id');
        if (byUser != null) return byUser;
        return null;
    };

    const checkFeatureAccess = async ({ userId, botId, action, messages = 1, tokens = 0 }) => {
        if (FORCE_SUBSCRIPTION_ACTIVE) {
            return { allowed: true, reason: 'forced_active' };
        }
        const subscriptionBundle = await getUserSubscription(userId);
        if (!subscriptionBundle || !subscriptionBundle.subscription) {
            return { allowed: false, reason: 'no_subscription' };
        }
        const { subscription, plan } = subscriptionBundle;
        if (!isSubscriptionActive(subscription)) {
            return { allowed: false, reason: 'subscription_inactive', subscription, plan };
        }
        const botsLimit = plan && Number.isFinite(Number(plan.bot_limit)) ? Number(plan.bot_limit) : null;
        const messageLimit = plan && Number.isFinite(Number(plan.monthly_message_limit)) ? Number(plan.monthly_message_limit) : null;
        if (action === 'create_bot' && botsLimit != null) {
            const { month, year } = getMonthYear();
            const record = await getUsageRecord(userId, botId, month, year);
            const current = record ? Number(record.bots_created) || 0 : 0;
            if (current + 1 > botsLimit) {
                return { allowed: false, reason: 'bots_limit_reached', limit: botsLimit, current, plan };
            }
        }
        if (action === 'send_message' && messageLimit != null) {
            const { month, year } = getMonthYear();
            const record = await getUsageRecord(userId, botId, month, year);
            const current = record ? Number(record.messages_used) || 0 : 0;
            if (current + Number(messages || 0) > messageLimit) {
                return { allowed: false, reason: 'message_limit_reached', limit: messageLimit, current, plan };
            }
        }
        return { allowed: true, subscription, plan, tokens: Number(tokens) || 0 };
    };

    const resetMonthlyUsage = async ({ userId, month, year }) => {
        if (!userId) return { success: false, reason: 'missing_user' };
        const m = Number.isFinite(month) ? month : getMonthYear().month;
        const y = Number.isFinite(year) ? year : getMonthYear().year;
        const { error } = await supabase
            .from('usage')
            .update({ messages_used: 0, bots_created: 0 })
            .eq('user_id', userId)
            .eq('month', m)
            .eq('year', y);
        if (error) return { success: false, reason: error.message || 'reset_failed' };
        return { success: true };
    };

    const changeUserPlan = async ({ userId, planId, status = 'active', billingCycle = 'monthly' }) => {
        if (!userId || !planId) return { success: false, reason: 'missing_fields' };
        const existing = await getActiveSubscriptionRow(userId);
        const payload = {
            user_id: userId,
            plan_id: planId,
            status
        };
        if (existing && existing.id) {
            const { error } = await supabase
                .from('user_subscriptions')
                .update(payload)
                .eq('id', existing.id);
            if (error) return { success: false, reason: error.message || 'update_failed' };
            return { success: true };
        }
        payload.created_at = nowIso();
        payload.razorpay_customer_id = null;
        payload.razorpay_subscription_id = null;
        const { error: insertError } = await supabase.from('user_subscriptions').insert(payload);
        if (insertError) return { success: false, reason: insertError.message || 'insert_failed' };
        return { success: true };
    };

    const activateTrial = async ({ userId, planId, trialDays = 7 }) => {
        if (!userId || !planId) return { success: false, reason: 'missing_fields' };
        const existing = await getActiveSubscriptionRow(userId);
        const payload = {
            user_id: userId,
            plan_id: planId,
            status: 'trial'
        };
        if (existing && existing.id) {
            const { error } = await supabase
                .from('user_subscriptions')
                .update(payload)
                .eq('id', existing.id);
            if (error) return { success: false, reason: error.message || 'update_failed' };
            return { success: true };
        }
        payload.created_at = nowIso();
        payload.razorpay_customer_id = null;
        payload.razorpay_subscription_id = null;
        const { error: insertError } = await supabase.from('user_subscriptions').insert(payload);
        if (insertError) return { success: false, reason: insertError.message || 'insert_failed' };
        return { success: true };
    };

    const listPlans = async () => {
        const { data, error } = await supabase.from('plans').select('*').order('price', { ascending: true });
        if (error) return [];
        return Array.isArray(data) ? data : [];
    };

    const listUsers = async () => {
        const { data, error } = await supabase.from('users').select('id, platform_user_id, bot_id, created_at').order('created_at', { ascending: false }).limit(200);
        if (error) return [];
        return Array.isArray(data) ? data : [];
    };

    const listSubscriptions = async () => {
        const { data, error } = await supabase
            .from('user_subscriptions')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(200);
        if (error) return [];
        return Array.isArray(data) ? data : [];
    };

    const getUsage = async ({ userId, botId, month, year }) => {
        if (!userId) return null;
        const m = Number.isFinite(month) ? month : getMonthYear().month;
        const y = Number.isFinite(year) ? year : getMonthYear().year;
        const { data, error } = await supabase
            .from('usage')
            .select('*')
            .eq('user_id', userId)
            .eq('month', m)
            .eq('year', y)
            .limit(1);
        if (error) return null;
        return Array.isArray(data) ? data[0] : null;
    };

    return {
        getUserSubscription,
        checkFeatureAccess,
        incrementUsage,
        resetMonthlyUsage,
        changeUserPlan,
        activateTrial,
        listPlans,
        listUsers,
        listSubscriptions,
        getUsage
    };
}

module.exports = createSubscriptionManager;
