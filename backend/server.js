const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const memoryStore = require('./memory/memoryStore');
const vectorSearch = require('./semantic/vectorSearch');
const { createIntentRouter } = require('./core/chat-processing');
const { processAIResponse, createAIBrain } = require('./core/ai-engine');
const ranker = require('./engines/ranker');
const tools = require('./core/tool-execution');
const createSubscriptionManager = require('./subscriptionManager');
const {
    searchProducts,
    semanticRecommendation,
    upsellRecommendation,
    crossSellRecommendation,
    describeSelectedProduct,
    compareRecentProducts,
    smartCompareProducts
} = require('./engines/productRecommendation');
const {
    attemptToSolveIssue,
    raiseSupportTicket,
    createSupportTicketCore,
    getTicketsReportToday
} = require('./engines/ticketService');
const {
    getProductCodeStatus,
    getLiveProducts,
    getRecommendedProductsForProduct,
    getProductCacheInfo,
    fetchContactInfoFromWebsite,
    fetchServiceCardsFromWebsite,
    fetchPricingPlansFromWebsite,
    loadKnowledgeData,
    queryKnowledgeChunks,
    updateKnowledgeBaseFromWebsite,
    updateKnowledgeBaseFromWebsiteEnhanced,
    queryKnowledgeBaseLive,
    enrichProductsWithPageExtras
} = require('./core/retrieval-system');
const botConfig = require('./config/bot_prompts');
const scraper = require('./services/scraper');
const companyConfig = botConfig.company;
const botBehaviorConfig = botConfig.behavior;
const botPrompts = botConfig.prompts;
const toolsConfig = botConfig.tools;
// Removed redundant knowledge_sources.json as it is now in bot_prompts.js
const knowledgeSourcesConfig = {
    homepage: botConfig.company.website_url,
    about_page: botConfig.company.website_url + botConfig.company.website_paths.about,
    pricing_page: botConfig.company.website_url + botConfig.company.website_paths.pricing,
    faq_page: botConfig.company.website_url + botConfig.company.website_paths.contact, // Using contact for FAQ if not explicitly defined
    product_pages: botConfig.product_urls
};

const app = express();
const server = http.createServer(app);
server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT || 8095} is already in use. Another instance of the Anhance server is probably running. Stop the existing process or change the PORT environment variable before starting again.`);
        process.exit(1);
    }
    console.error("❌ HTTP server error:", err && err.message ? err.message : err);
});
const io = require("socket.io")(server, {
    path: "/ws/socket.io",
    cors: { origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"], credentials: false },
    transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 8080;

// Start Scraping on startup
(async () => {
    try {
        await scraper.scrapeAll();
        console.log("✅ Scraper successfully initialized on startup.");
    } catch (e) {
        console.error("❌ Scraper startup error:", e.message);
    }
})();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GPT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const KB_VECTOR_MATCH_THRESHOLD = Number(process.env.KB_VECTOR_MATCH_THRESHOLD || '0.70');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const BRAND_NAME = companyConfig.company_name || companyConfig.chatbot_name || 'Company';
const BRAND_WEBSITE = String(companyConfig.website_url || '').replace(/\/$/, '');
const WEBSITE_PATHS = companyConfig.website_paths || {};
const SUPPORT_EMAIL = companyConfig.support_email || '';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const aiBrain = createAIBrain({ openai, model: GPT_MODEL });
const globalTokenStats = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
};

function normalizeProductLinkForFrontend(link) {
    const s = String(link || '').trim();
    if (!s) return '';
    const m = s.match(/\/products\/([^\/\?#]+)/i);
    if (m && m[1]) {
        return `${BRAND_WEBSITE}/products/${m[1]}`;
    }
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('/')) return `${BRAND_WEBSITE}${s}`;
    return '';
}

function logTokenUsage(source, meta, completion, messages) {
    try {
        const usage = completion && completion.usage ? completion.usage : {};
        const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
        const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
        const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : (promptTokens + completionTokens);
        let inputChars = null;
        if (Array.isArray(messages)) {
            inputChars = messages.reduce((sum, m) => {
                const c = m && m.content != null ? String(m.content) : '';
                return sum + c.length;
            }, 0);
        }
        globalTokenStats.calls += 1;
        globalTokenStats.promptTokens += promptTokens;
        globalTokenStats.completionTokens += completionTokens;
        globalTokenStats.totalTokens += totalTokens;

        const payload = {
            source: String(source || ''),
            model: meta && meta.model ? meta.model : GPT_MODEL,
            userId: meta && meta.userId ? String(meta.userId) : null,
            promptTokens,
            completionTokens,
            totalTokens,
            inputChars
        };
        console.log("LLM_CALL_METRICS", payload);
        console.log("LLM_TOKEN_TOTALS", {
            calls: globalTokenStats.calls,
            promptTokens: globalTokenStats.promptTokens,
            completionTokens: globalTokenStats.completionTokens,
            totalTokens: globalTokenStats.totalTokens
        });
    } catch (e) {}
}

function logToolCall(name, meta) {
    try {
        const payload = {
            name: String(name || ''),
            userId: meta && meta.userId != null ? String(meta.userId) : null,
            source: meta && meta.source ? String(meta.source) : null,
            inputChars: meta && typeof meta.inputChars === 'number' ? meta.inputChars : null,
            details: meta && meta.details != null ? meta.details : undefined
        };
        console.log("TOOL_CALL", payload);
    } catch (e) {}
}

async function detectLanguageCode(text, fallbackCode = 'auto') {
    const raw = String(text || '').trim();
    if (!raw) return fallbackCode || 'auto';
    try {
        const systemPrompt = 'Return only the main language of the user message as a short ISO 639-1 code (for example "en" or "hi"). If the message mixes languages, choose the dominant one. If you are unsure, return "auto". Do not add any explanation or extra text.';
        const content = raw.slice(0, 240);
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content }
        ];
        const completion = await openai.chat.completions.create({
            model: GPT_MODEL,
            messages,
            max_completion_tokens: 8,
            temperature: 0
        });
        logTokenUsage("detect_language", { model: GPT_MODEL }, completion, messages);
        const choice = completion && completion.choices && completion.choices[0] ? completion.choices[0] : {};
        const msg = choice.message && choice.message.content ? String(choice.message.content).trim().toLowerCase() : '';
        const match = msg.match(/[a-z]{2}/);
        return match ? match[0] : (fallbackCode || 'auto');
    } catch (e) {
        return fallbackCode || 'auto';
    }
}

function extractFirstJsonObject(text) {
    const s = String(text || '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    return s.slice(start, end + 1);
}

async function analyzeUserIntentMandatory(user_id, message) {
    const content = typeof message === 'string' ? message : JSON.stringify(message);
    const trimmed = String(content || '').trim();
    if (!trimmed) return null;
    const promptTemplate = botPrompts && typeof botPrompts.intentAnalyzerSystemPrompt === 'string'
        ? botPrompts.intentAnalyzerSystemPrompt
        : `You are an intent analyzer for the ${BRAND_NAME} chatbot. Reply with exactly one JSON object: { "language": "<code>", "intent": "<string>", "wants": [], "productCodes": [], "budget": <number|null>, "confidence": <0-1> }. No markdown, no extra text, no explanation.`;
    const systemPrompt = promptTemplate.replace(/\{BRAND_NAME\}/g, BRAND_NAME);
    const state = getUserState(user_id);
    const pageCtx = state && state.pageContext ? JSON.stringify(state.pageContext) : '{}';
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'system', content: `Current page context JSON: ${pageCtx}` },
        { role: 'user', content: trimmed.slice(0, 600) }
    ];
    const completion = await openai.chat.completions.create({
        model: GPT_MODEL,
        messages,
        max_completion_tokens: 2000,
        temperature: 0
    });
    logTokenUsage("intent_analysis", { model: GPT_MODEL, userId: user_id }, completion, messages);
    const choice = completion && completion.choices && completion.choices[0] ? completion.choices[0] : {};
    const out = choice.message && choice.message.content ? String(choice.message.content).trim() : '';
    const json = extractFirstJsonObject(out);
    if (!json) {
        return { raw: out };
    }
    try {
        return JSON.parse(json);
    } catch (e) {
        return { raw: out };
    }
}

const WHATSAPP_TOKEN = process.env.WHATSAPP_TEMP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const BOT_ID = process.env.BOT_ID;

if (!BOT_ID) {
    throw new Error("FATAL: BOT_ID missing in .env");
}

console.log("BOT_ID IN USE:", BOT_ID);

function getBotId() {
    return BOT_ID;
}

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

if (!supabase) {
    console.warn("⚠️ Supabase is not fully configured. SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY is missing.");
}
const subscriptionManager = createSubscriptionManager({ supabase, getBotId });
let isBotSubscriptionActive = false;
let lastSubscriptionCheckAt = 0;

async function refreshBotSubscriptionStatus(force = false) {
    isBotSubscriptionActive = true;
    return;
    const now = Date.now();
    if (!force && lastSubscriptionCheckAt && (now - lastSubscriptionCheckAt) < 60000) {
        return;
    }
    lastSubscriptionCheckAt = now;
    try {
        const { data, error } = await supabase
            .from('bot_subscriptions')
            .select('*')
            .eq('bot_id', getBotId())
            .maybeSingle();
        if (error || !data) {
            isBotSubscriptionActive = false;
            return;
        }
        let active = false;
        if (typeof data.is_active === 'boolean') {
            active = data.is_active;
        } else if (typeof data.status === 'string') {
            const s = data.status.toLowerCase();
            active = s === 'active' || s === 'trialing';
        }
        const endsAt = data.valid_until || data.current_period_end || data.expires_at || data.ends_at;
        if (endsAt) {
            const t = new Date(endsAt).getTime();
            if (!Number.isNaN(t) && t < now) {
                active = false;
            }
        }
        isBotSubscriptionActive = !!active;
    } catch (e) {
        isBotSubscriptionActive = false;
    }
}

async function ensureSubscriptionActiveOrNotify(socket, user_id) {
    await refreshBotSubscriptionStatus(false);
    if (isBotSubscriptionActive) {
        return true;
    }
    try {
        const text = "Dost, is bot ki subscription active nahi hai. Payment pending hai isliye abhi service band hai. Jaise hi payment complete hogi service automatic resume ho jayegi.";
        await sendMessage(socket, text, user_id);
    } catch (e) {}
    return false;
}

const conversationHistories = new Map();
const userStates = new Map();
const userCache = new Map();
const MAX_HISTORY_LENGTH = 10;
const ticketStates = new Map();
const liveUserSockets = new Map();

const _userStatesSet = userStates.set.bind(userStates);
const _userStatesDelete = userStates.delete.bind(userStates);
userStates.set = function(user_id, state) {
    const r = _userStatesSet(user_id, state);
    memoryStore.memoryCache[user_id] = state;
    memoryStore.scheduleSave();
    return r;
};
userStates.delete = function(user_id) {
    const r = _userStatesDelete(user_id);
    delete memoryStore.memoryCache[user_id];
    memoryStore.scheduleSave();
    return r;
};

function sanitizeConversationContext(conversationContext) {
    if (!Array.isArray(conversationContext)) return [];
    return sanitizeOpenAIMessages(conversationContext);
}

function sanitizeUserStateObject(state) {
    if (!state || typeof state !== 'object') return null;
    const normalized = { ...state };
    normalized.conversationContext = sanitizeConversationContext(normalized.conversationContext);
    normalized.conversationAll = sanitizeConversationContext(normalized.conversationAll);
    return normalized;
}

function sanitizePageContext(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    if (raw.type != null) out.type = String(raw.type);
    if (raw.url != null) out.url = String(raw.url);
    if (raw.path != null) out.path = String(raw.path);
    if (raw.title != null) out.title = String(raw.title);
    if (raw.referrer != null) out.referrer = String(raw.referrer);
    if (raw.meta && typeof raw.meta === 'object') {
        const metaOut = {};
        Object.keys(raw.meta).slice(0, 10).forEach((key) => {
            const v = raw.meta[key];
            if (v != null) metaOut[key] = String(v);
        });
        out.meta = metaOut;
    }
    return out;
}

function createConversationId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return crypto.randomBytes(16).toString('hex');
}

function updateUserPageContext(user_id, pageContext) {
    if (!user_id) return;
    const state = getUserState(user_id);
    state.pageContext = sanitizePageContext(pageContext);
    setUserState(user_id, state);
}

// Sanitize any persisted memory at startup to avoid invalid roles (e.g., `bot`) causing OpenAI errors
try {
    if (memoryStore && memoryStore.memoryCache && typeof memoryStore.memoryCache === 'object') {
        for (const [userId, rawState] of Object.entries(memoryStore.memoryCache)) {
            const sanitizedState = sanitizeUserStateObject(rawState);
            if (sanitizedState) {
                memoryStore.memoryCache[userId] = sanitizedState;
                _userStatesSet(userId, sanitizedState);
            } else {
                delete memoryStore.memoryCache[userId];
            }
        }
        if (typeof memoryStore.scheduleSave === 'function') {
            memoryStore.scheduleSave();
        }
    }
} catch (e) {
    console.error('⚠️ Failed to sanitize persisted memory on startup:', e.message);
}

function createDefaultUserState() {
    return {
        mode: null,
        hasWelcomed: false,
        userName: null,
        namePrompted: false,
        nameDeclined: false,
        awaitingName: false,
        email: null,
        phone: null,
        contactPrompted: false,
        contactDeclined: false,
        awaitingContact: false,
        languageCode: 'en',
        humanHandoffActive: false,
        humanHandoffRequestedAt: null,
        preferences: { size: null, budget: null, colors: [], styles: [] },
        conversationContext: [],
        conversationAll: [],
        lastSearchResults: [],
        lastDisplayedProducts: [],
        lastDetailedProduct: null,
        lastComparedProducts: [],
        viewedProducts: [],
        displayedProductsHistory: [],
        productViewIndex: 0,
        intent: null,
        sentiment: null,
        issues: [],
        lastQueryProducts: [],
        recentProductsHistory: [],
        comparedProducts: [],
        pendingOccasionPreference: null,
        lastResponseModeDecision: null,
        lastAnswerMeta: null,
        pageContext: null,
        sessionContext: {
            turns: [],
            lastFocusedProductId: null,
            lastTurnId: 0
        },
        lastServiceCards: [],
        lastPricingPlans: [],
        lastServiceCardsIndex: 0,
        lastPricingPlansIndex: 0,
        lastDisplayedCardsType: null,
        conversationId: createConversationId()
    };
}

function getUserState(user_id) {
    if (!userStates.has(user_id) || typeof userStates.get(user_id) !== 'object') {
        userStates.set(user_id, createDefaultUserState());
    }
    const st = userStates.get(user_id);
    if (st && !st.conversationId) {
        st.conversationId = createConversationId();
        userStates.set(user_id, st);
    }
    return userStates.get(user_id);
}

const setUserState = (user_id, state) => {
    if (state === undefined) {
        userStates.delete(user_id);
    } else {
        userStates.set(user_id, state);
    }
};
const deleteUserState = (user_id) => userStates.delete(user_id);

function pushConversation(state, role, content) {
    if (!state || typeof content !== 'string') return;
    const normalizedRole = role === 'bot' ? 'assistant' : role;
    const redact = (text) => {
        let t = String(text || '');
        if (normalizedRole === 'assistant') return t;
        t = t.replace(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/ig, '[redacted_email]');
        t = t.replace(/\b(\+?\d[\d\s().-]{8,}\d)\b/g, '[redacted_phone]');
        return t;
    };
    const now = new Date().toISOString();
    let fullContent = redact(content);
    if (fullContent.length > 5000) {
        const head = fullContent.slice(0, 3800);
        const tail = fullContent.slice(-900);
        fullContent = `${head}\n...\n${tail}`;
    }

    state.conversationAll = Array.isArray(state.conversationAll) ? state.conversationAll : [];
    state.conversationAll.push({ role: normalizedRole, content: fullContent, at: now });
    while (state.conversationAll.length > 2000) state.conversationAll.shift();

    let safeContent = fullContent;
    if (safeContent.length > 900) {
        const head = safeContent.slice(0, 650);
        const tail = safeContent.slice(-200);
        safeContent = `${head}\n...\n${tail}`;
    }
    state.conversationContext = (Array.isArray(state.conversationContext) ? state.conversationContext : []);
    const summarizeConversation = (msgs) => {
        const items = (Array.isArray(msgs) ? msgs : [])
            .map(m => {
                const r = (m && m.role) ? String(m.role) : 'unknown';
                const c = (m && typeof m.content === 'string') ? m.content : '';
                const oneLine = c.replace(/\s+/g, ' ').trim().replace(/\b\d{3,6}\b/g, '[code]');
                if (!oneLine) return '';
                const clipped = oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
                return `${r}: ${clipped}`;
            })
            .filter(Boolean);
        const joined = items.join(' | ');
        if (!joined) return '';
        return `Conversation summary: ${joined}`;
    };

    const mergeSummary = (existing, next) => {
        const a = typeof existing === 'string' ? existing.trim() : '';
        const b = typeof next === 'string' ? next.trim() : '';
        if (!a) return b;
        if (!b) return a;
        const merged = `${a} / ${b}`.trim();
        return merged.length > 700 ? `${merged.slice(0, 700)}…` : merged;
    };

    state.conversationContext.push({ role: normalizedRole, content: safeContent });
    if (state.conversationContext.length > 8) {
        const older = state.conversationContext.slice(0, 4);
        const summaryText = summarizeConversation(older);
        if (summaryText) {
            state.conversationSummary = mergeSummary(state.conversationSummary, summaryText);
        }
        const tail = state.conversationContext.slice(4).slice(-7);
        state.conversationContext = [
            ...(state.conversationSummary ? [{ role: 'system', content: state.conversationSummary }] : []),
            ...tail
        ].slice(-8);
    }
    try {
        if (memoryStore && typeof memoryStore.scheduleSave === 'function') {
            memoryStore.scheduleSave();
        }
    } catch (e) {}
}

function updatePreferences(state, message) {
    const t = String(message || '').toLowerCase();
    const sizeMatch = t.match(/\b(size\\s*(\d{1,2})|(\d{1,2})\\s*(uk|eu)?)\b/);
    if (sizeMatch) {
        const sizeVal = sizeMatch[2] || sizeMatch[3];
        state.preferences.size = sizeVal ? String(sizeVal) : state.preferences.size;
    }
    const colors = ['black','brown','white','beige','tan','nude','blue','red','green','grey','gray'];
    const styles = ['office wear','office','daily','casual','heels','flats','sandals','sneakers','loafers','boots'];
    colors.forEach(c => {
        if (t.includes(c)) {
            const set = new Set(state.preferences.colors || []);
            set.add(c);
            state.preferences.colors = Array.from(set);
        }
    });
    styles.forEach(s => {
        if (t.includes(s)) {
            const set = new Set(state.preferences.styles || []);
            set.add(s);
            state.preferences.styles = Array.from(set);
        }
    });
}

app.use(express.json());
app.get('/favicon.ico', (req, res) => res.status(204).send());
app.use('/config/bot_prompts.js', express.static(path.join(__dirname, 'config/bot_prompts.js')));
app.use(express.static(path.join(__dirname, '../frontend')));
const isAdminAuthorized = (req) => {
    const body = req.body || {};
    const authHeader = req.headers['x-admin-password'] || req.headers['x-agent-secret'];
    const expectedSecret = ADMIN_PASSWORD ? String(ADMIN_PASSWORD) : null;
    const bodySecret = body && typeof body.admin_password === 'string' ? body.admin_password : null;
    if (expectedSecret && authHeader !== expectedSecret && bodySecret !== expectedSecret) {
        return false;
    }
    return true;
};
const agentController = {
    run: async (socket, message, user_id) => {
        const st = getUserState(user_id) || {};
        if ((!Array.isArray(st.conversationContext) || st.conversationContext.length < 2) && socket && socket.__dbUserId) {
            const recent = await fetchRecentConversationFromDb(socket.__dbUserId, 8);
            if (recent && recent.length) {
                st.conversationContext = recent.slice(-8);
                setUserState(user_id, st);
            }
        }
        let history = conversationHistories.get(user_id) || [];
        history.push({ role: 'user', content: message });
        await processAIResponse(socket, user_id, history);
        conversationHistories.set(user_id, history);
    }
};
const intentRouter = createIntentRouter({
    getUserState,
    setUserState,
    updatePreferences,
    pushConversation,
    agentController,
    aiBrain
});

app.post('/api/handoff/agent-message', async (req, res) => {
    try {
        const body = req.body || {};
        const authHeader = req.headers['x-admin-password'] || req.headers['x-agent-secret'];
        const expectedSecret = ADMIN_PASSWORD ? String(ADMIN_PASSWORD) : null;
        const bodySecret = body && typeof body.admin_password === 'string' ? body.admin_password : null;
        if (expectedSecret && authHeader !== expectedSecret && bodySecret !== expectedSecret) {
            res.status(403).json({ success: false, error: 'forbidden' });
            return;
        }
        const rawUserId = body.platformUserId || body.platform_user_id || body.user_id || body.chat_user_id || body.chatUserId;
        const text = body.message || body.text;
        const platformUserId = rawUserId != null ? String(rawUserId) : "";
        if (!platformUserId || !text) {
            res.status(400).json({ success: false, error: 'missing_fields' });
            return;
        }
        const delivered = await sendAgentMessageToUser(platformUserId, String(text));
        console.log("AGENT_MESSAGE_DELIVERY_RESULT", { 
            userId: platformUserId, 
            delivered: !!delivered,
            messageLength: String(text).length 
        });
        res.json({ success: true, delivered: !!delivered });
    } catch (e) {
        res.status(500).json({ success: false, error: 'internal_error' });
    }
});

app.post('/api/popup-ai', async (req, res) => {
    try {
        const body = req.body || {};
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 240) : '';
        if (!prompt) {
            res.status(400).json({ success: false, error: 'missing_prompt' });
            return;
        }
        const maxTokensRaw = Number(body.max_tokens);
        const maxTokens = Number.isFinite(maxTokensRaw)
            ? Math.max(1, Math.min(2000, Math.floor(maxTokensRaw)))
            : 200;
        const messages = [{ role: 'user', content: prompt }];
        const completion = await openai.chat.completions.create({
            model: GPT_MODEL,
            messages,
            max_completion_tokens: maxTokens,
            temperature: 0.2
        });
        logTokenUsage("popup_ai", { model: GPT_MODEL }, completion, messages);
        const choice = completion && completion.choices && completion.choices[0] ? completion.choices[0] : {};
        const msg = choice.message && typeof choice.message.content === 'string' ? choice.message.content.trim() : '';
        res.json({ success: true, message: msg });
    } catch (e) {
        res.status(500).json({ success: false, error: 'internal_error' });
    }
});

app.get('/api/admin/plans', async (req, res) => {
    if (!isAdminAuthorized(req)) {
        res.status(403).json({ success: false, error: 'forbidden' });
        return;
    }
    const plans = await subscriptionManager.listPlans();
    res.json({ success: true, plans });
});

app.get('/api/admin/users', async (req, res) => {
    if (!isAdminAuthorized(req)) {
        res.status(403).json({ success: false, error: 'forbidden' });
        return;
    }
    const users = await subscriptionManager.listUsers();
    res.json({ success: true, users });
});

app.get('/api/admin/subscriptions', async (req, res) => {
    if (!isAdminAuthorized(req)) {
        res.status(403).json({ success: false, error: 'forbidden' });
        return;
    }
    const subscriptions = await subscriptionManager.listSubscriptions();
    res.json({ success: true, subscriptions });
});

app.get('/api/admin/subscription/:userId', async (req, res) => {
    if (!isAdminAuthorized(req)) {
        res.status(403).json({ success: false, error: 'forbidden' });
        return;
    }
    const userId = req.params.userId ? String(req.params.userId) : '';
    if (!userId) {
        res.status(400).json({ success: false, error: 'missing_user_id' });
        return;
    }
    const data = await subscriptionManager.getUserSubscription(userId);
    res.json({ success: true, data });
});

app.post('/api/admin/subscriptions/change-plan', async (req, res) => {
    if (!isAdminAuthorized(req)) {
        res.status(403).json({ success: false, error: 'forbidden' });
        return;
    }
    const body = req.body || {};
    const userId = body.user_id != null ? String(body.user_id) : '';
    const planId = body.plan_id != null ? String(body.plan_id) : '';
    const status = body.status ? String(body.status) : 'active';
    const billingCycle = body.billing_cycle ? String(body.billing_cycle) : 'monthly';
    if (!userId || !planId) {
        res.status(400).json({ success: false, error: 'missing_fields' });
        return;
    }
    const result = await subscriptionManager.changeUserPlan({ userId, planId, status, billingCycle });
    res.json({ success: !!result.success, result });
});

app.post('/api/admin/subscriptions/activate-trial', async (req, res) => {
    if (!isAdminAuthorized(req)) {
        res.status(403).json({ success: false, error: 'forbidden' });
        return;
    }
    const body = req.body || {};
    const userId = body.user_id != null ? String(body.user_id) : '';
    const planId = body.plan_id != null ? String(body.plan_id) : '';
    const trialDays = Number.isFinite(Number(body.trial_days)) ? Number(body.trial_days) : 7;
    if (!userId || !planId) {
        res.status(400).json({ success: false, error: 'missing_fields' });
        return;
    }
    const result = await subscriptionManager.activateTrial({ userId, planId, trialDays });
    res.json({ success: !!result.success, result });
});

app.post('/api/admin/subscriptions/reset-usage', async (req, res) => {
    if (!isAdminAuthorized(req)) {
        res.status(403).json({ success: false, error: 'forbidden' });
        return;
    }
    const body = req.body || {};
    const userId = body.user_id != null ? String(body.user_id) : '';
    if (!userId) {
        res.status(400).json({ success: false, error: 'missing_user_id' });
        return;
    }
    const month = Number.isFinite(Number(body.month)) ? Number(body.month) : undefined;
    const year = Number.isFinite(Number(body.year)) ? Number(body.year) : undefined;
    const result = await subscriptionManager.resetMonthlyUsage({ userId, month, year });
    res.json({ success: !!result.success, result });
});

app.post('/api/admin/knowledge/refresh', async (req, res) => {
    if (!isAdminAuthorized(req)) {
        res.status(403).json({ success: false, error: 'forbidden' });
        return;
    }
    const body = req.body || {};
    const userId = body.user_id != null ? String(body.user_id) : '';
    const groupNames = Array.isArray(body.group_names) ? body.group_names : ['main_pages', 'policy_pages'];
    if (!userId) {
        res.status(400).json({ success: false, error: 'missing_user_id' });
        return;
    }
    const access = await subscriptionManager.checkFeatureAccess({
        userId,
        botId: getBotId(),
        action: 'scrape_knowledge',
        messages: 0,
        tokens: 0
    });
    if (!access.allowed) {
        res.status(403).json({ success: false, error: access.reason, details: access });
        return;
    }
    await updateKnowledgeBaseFromWebsiteEnhanced(groupNames);
    res.json({ success: true });
});

const buildSystemPrompt = () => {
    const companyName = BRAND_NAME || "Company";
    const chatbotName = companyConfig.chatbot_name || companyName;
    const tone = botBehaviorConfig.tone || companyConfig.brand_tone || "helpful";
    const role = botBehaviorConfig.assistant_role || "assistant";
    const language = botBehaviorConfig.language || "en";
    const greeting = botBehaviorConfig.greeting_message || "";
    const sources = [
        knowledgeSourcesConfig.homepage,
        knowledgeSourcesConfig.about_page,
        knowledgeSourcesConfig.pricing_page,
        knowledgeSourcesConfig.faq_page,
        ...(Array.isArray(knowledgeSourcesConfig.product_pages) ? knowledgeSourcesConfig.product_pages : [])
    ].filter(Boolean);
    const toolList = Object.entries(toolsConfig || {})
        .filter(([, enabled]) => !!enabled)
        .map(([name]) => name.replace(/_/g, " "));
    const sourceLines = sources.length ? sources.map((s) => `- ${s}`).join("\n") : "- none";
    const toolLines = toolList.length ? toolList.map((t) => `- ${t}`).join("\n") : "- none";
    const sales = botPrompts && botPrompts.salesSystemPrompt && typeof botPrompts.salesSystemPrompt === 'object'
        ? botPrompts.salesSystemPrompt
        : null;
    const identityLine = sales && typeof sales.identityLine === 'string'
        ? sales.identityLine
        : "You are {CHATBOT_NAME}, {BRAND_NAME}'s {ROLE}.";
    const toneLanguageLine = sales && typeof sales.toneLanguageLine === 'string'
        ? sales.toneLanguageLine
        : "Tone: {TONE}. Language: {LANGUAGE}.";
    const greetingLine = greeting && (sales && typeof sales.greetingLine === 'string' ? sales.greetingLine : "Greeting to use when needed: {GREETING}");
    const goals = sales && Array.isArray(sales.goals) ? sales.goals : [];
    const styleRules = sales && Array.isArray(sales.styleRules) ? sales.styleRules : [];
    const render = (tpl) => String(tpl || '')
        .replace(/\{BRAND_NAME\}/g, companyName)
        .replace(/\{CHATBOT_NAME\}/g, chatbotName)
        .replace(/\{ROLE\}/g, role)
        .replace(/\{TONE\}/g, tone)
        .replace(/\{LANGUAGE\}/g, language)
        .replace(/\{GREETING\}/g, greeting);
    return [
        render(identityLine),
        render(toneLanguageLine),
        greetingLine ? render(greetingLine) : "",
        goals.length ? "Goals:" : "",
        ...goals.map((g) => `- ${String(g)}`),
        "Knowledge sources:",
        sourceLines,
        "Enabled tools:",
        toolLines,
        styleRules.length ? "Language and style:" : "",
        ...styleRules.map((r) => `- ${String(r)}`)
    ].filter(Boolean).join("\n");
};

const SALES_SYSTEM_PROMPT = buildSystemPrompt();

const getSystemPrompt = (isAdmin) => {
    if (isAdmin) {
        return botPrompts && typeof botPrompts.adminSystemPrompt === 'string'
            ? String(botPrompts.adminSystemPrompt)
            : `You are the administrative assistant. Tone is professional and direct.\nAdmin Directives:\n1. When asked for a report (e.g., "today's tickets"), call the 'admin_mode' tool with command 'get_report' and the corresponding value.\n2. If the user says "sleep" or "exit", your only response is to call 'admin_mode' with the command 'sleep'.`;
    }
    return buildSystemPrompt();
};

function fuzzyMatchProducts(products, userQuery, threshold = 0.45) {
    const q = String(userQuery || "").toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const scored = products.map(p => {
        const titleWords = String(p.name || "").toLowerCase().split(/\s+/);
        let matchCount = 0;
        for (const w of q) {
            if (titleWords.some(t => t.includes(w))) matchCount++;
        }
        const score = q.length ? (matchCount / q.length) : 0;
        return { product: p, score };
    });
    const filtered = scored
        .filter(s => s.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .map(s => s.product);
    return filtered.slice(0, 3);
}

function normalizeForDirectNameMatch(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/\(\s*\d{3,6}\s*\)/g, "")
        .replace(/\d{3,6}/g, "")
        .replace(/[^a-z]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function shouldShowServiceCards(text) {
    const lc = String(text || '').toLowerCase();
    const keywords = [
        'service',
        'services',
        'feature',
        'features',
        'capability',
        'capabilities',
        'solution',
        'solutions',
        'demo'
    ];
    for (const word of keywords) {
        if (lc.includes(word)) return true;
    }
    return false;
}

function shouldShowProductCards(text) {
    const lc = String(text || '').toLowerCase();
    const keywords = [
        'product',
        'products',
        'catalog',
        'catalogue',
        'shop',
        'buy',
        'purchase',
        'collection'
    ];
    for (const word of keywords) {
        if (lc.includes(word)) return true;
    }
    return false;
}

function shouldShowPricingCards(text) {
    const lc = String(text || '').toLowerCase();
    const keywords = [
        'pricing',
        'price',
        'plan',
        'plans',
        'cost',
        'charges',
        'monthly',
        'month',
        'yearly',
        'year'
    ];
    for (const word of keywords) {
        if (lc.includes(word)) return true;
    }
    return false;
}

function shouldForceCardsForMessage(text) {
    const lc = String(text || '').toLowerCase();
    if (!lc.trim()) return null;
    const supportOrPolicy = /(return|refund|exchange|replacement|shipping|delivery|policy|terms|privacy|contact|email|phone|whatsapp|support|help|issue|problem|complaint|ticket|order|tracking|track)\b/i;
    if (supportOrPolicy.test(lc)) return null;
    const followUpDetails = /(about|details?|detail|info|information|describe|description|explain|bata|bta|batao|btao|btado|btana|batana|ba(re|are)\s*(me|m|mai)|ke\s+ba(re|are)\s*(me|m|mai)|ka\s+ba(re|are)\s*(me|m|mai)|jankari|janakari|specs?|features?)/i;
    const shownProductRef = /(this|that|yeh?|ye|is|us|iska|uska|iske|uske|wali|wala|wale|product|item|option|first|1st|1|second|2nd|2|third|3rd|3|pehla|pahla|pehle|pahle|phle|dusra|dusri|doosra|doosri|dusre|teesra|tisra)/i;
    if (followUpDetails.test(lc) && shownProductRef.test(lc)) return null;
    if (shouldShowPricingCards(lc)) return { type: 'pricing' };
    if (shouldShowProductCards(lc)) return { type: 'product' };
    if (shouldShowServiceCards(lc)) return { type: 'service' };
    return null;
}

const CARD_PAGE_SIZE = 3;

function extractWordsForMatch(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2);
}

function findBestCardMatch(cards, userQuery) {
    const qWords = extractWordsForMatch(userQuery);
    if (!qWords.length) return null;
    let best = null;
    let bestScore = 0;
    for (const card of cards) {
        const nameWords = extractWordsForMatch(card && card.name ? card.name : '');
        if (!nameWords.length) continue;
        const overlap = nameWords.filter(w => qWords.includes(w)).length;
        const score = overlap / nameWords.length;
        if (overlap > 0 && score > bestScore) {
            best = card;
            bestScore = score;
        }
    }
    return best;
}

function composePricingAnswerFromCards(userQuery, cards) {
    const list = Array.isArray(cards) ? cards : [];
    if (!list.length) return '';
    const matched = findBestCardMatch(list, userQuery);
    if (matched) {
        const price = matched.price ? `Price: ${matched.price}. ` : '';
        const features = Array.isArray(matched.features) ? matched.features.slice(0, 6) : [];
        const featuresText = features.length ? `Features: ${features.join(', ')}. ` : '';
        const link = matched.link ? `Details: ${matched.link}` : '';
        return `${matched.name} plan. ${price}${featuresText}${link}`.trim();
    }
    const summary = list.slice(0, 3).map(p => `${p.name}${p.price ? ` - ${p.price}` : ''}`).join(', ');
    return summary
        ? `Pricing plans: ${summary}. Aap apna monthly traffic/users bata do, main best plan suggest kar dunga.`
        : '';
}

function composeServiceAnswerFromCards(userQuery, cards) {
    const list = Array.isArray(cards) ? cards : [];
    if (!list.length) return '';
    const matched = findBestCardMatch(list, userQuery);
    if (matched) {
        const desc = matched.description ? `${matched.description}. ` : '';
        const link = matched.link ? `Details: ${matched.link}` : '';
        return `${matched.name}: ${desc}${link}`.trim();
    }
    const summary = list.slice(0, 3).map(s => s.name).filter(Boolean).join(', ');
    return summary
        ? `Main services dikhा रहा hoon: ${summary}. Aap kis use-case ke liye dekh rahe ho?`
        : '';
}

async function sendServiceCards(socket, userId, userQuery, options = {}) {
    const st = getUserState(userId);
    const force = options && options.force === true;
    const cards = await fetchServiceCardsFromWebsite(force);
    if (Array.isArray(cards) && cards.length) {
        const start = Number.isFinite(Number(st.lastServiceCardsIndex)) ? Number(st.lastServiceCardsIndex) : 0;
        const slice = cards.slice(start, start + CARD_PAGE_SIZE);
        if (!slice.length) {
            if (!socket.isWhatsApp) {
                await sendMessage(socket, { type: '__CONTROL_SHOW_MORE__', data: { show: false } }, userId);
            }
            await sendMessage(socket, "You’ve seen all the services.", userId);
            return true;
        }
        const nextIndex = start + slice.length;
        const hasMore = nextIndex < cards.length;
        st.lastServiceCards = cards;
        st.lastServiceCardsIndex = nextIndex;
        st.lastDisplayedCardsType = 'service';
        setUserState(userId, st);
        await sendMessage(socket, { type: '__SERVICE_CARDS__', data: slice }, userId);
        if (!socket.isWhatsApp) {
            await sendMessage(socket, { type: '__CONTROL_SHOW_MORE__', data: { show: hasMore } }, userId);
        }
        const summary = start === 0 ? composeServiceAnswerFromCards(userQuery, slice) : "";
        if (summary) {
            await sendMessage(socket, summary, userId);
        }
        return true;
    }
    return false;
}

async function sendPricingCards(socket, userId, userQuery, options = {}) {
    const st = getUserState(userId);
    const force = options && options.force === true;
    const cards = await fetchPricingPlansFromWebsite(force);
    if (Array.isArray(cards) && cards.length) {
        const start = Number.isFinite(Number(st.lastPricingPlansIndex)) ? Number(st.lastPricingPlansIndex) : 0;
        const slice = cards.slice(start, start + CARD_PAGE_SIZE);
        if (!slice.length) {
            if (!socket.isWhatsApp) {
                await sendMessage(socket, { type: '__CONTROL_SHOW_MORE__', data: { show: false } }, userId);
            }
            await sendMessage(socket, "You’ve seen all the pricing plans.", userId);
            return true;
        }
        const nextIndex = start + slice.length;
        const hasMore = nextIndex < cards.length;
        st.lastPricingPlans = cards;
        st.lastPricingPlansIndex = nextIndex;
        st.lastDisplayedCardsType = 'pricing';
        setUserState(userId, st);
        await sendMessage(socket, { type: '__PRICING_PLANS__', data: slice }, userId);
        if (!socket.isWhatsApp) {
            await sendMessage(socket, { type: '__CONTROL_SHOW_MORE__', data: { show: hasMore } }, userId);
        }
        const summary = start === 0 ? composePricingAnswerFromCards(userQuery, slice) : "";
        if (summary) {
            await sendMessage(socket, summary, userId);
        }
        return true;
    }
    return false;
}

function extractSelectionIndex(selectionText) {
    const lc = String(selectionText || '').toLowerCase();
    const ordMap = {
        first: 0,
        '1st': 0,
        one: 0,
        '1': 0,
        second: 1,
        '2nd': 1,
        two: 1,
        '2': 1,
        third: 2,
        '3rd': 2,
        three: 2,
        '3': 2
    };
    const match = lc.match(/\b(first|1st|one|1|second|2nd|two|2|third|3rd|three|3)\b/);
    if (!match) return null;
    const idx = ordMap[match[1]];
    return Number.isFinite(idx) ? idx : null;
}

function resolveCardFromSelection(cards, selectionText, selectionIndex) {
    const list = Array.isArray(cards) ? cards : [];
    if (!list.length) return null;
    const directIndex = selectionIndex != null && Number.isFinite(Number(selectionIndex))
        ? Math.trunc(Number(selectionIndex))
        : null;
    if (directIndex != null) {
        if (list[directIndex]) return list[directIndex];
        if (directIndex > 0 && list[directIndex - 1]) return list[directIndex - 1];
    }
    const idx = extractSelectionIndex(selectionText);
    if (idx != null) {
        if (list[idx]) return list[idx];
        if (idx > 0 && list[idx - 1]) return list[idx - 1];
    }
    if (selectionText) {
        const byName = findBestCardMatch(list, selectionText);
        if (byName) return byName;
    }
    return list[0] || null;
}

function extractCompareNames(text) {
    const raw = String(text || '');
    const betweenMatch = raw.match(/\bbetween\s+(.+?)\s+and\s+(.+?)(?:[?.!]|$)/i);
    if (betweenMatch) {
        const a = String(betweenMatch[1] || '').trim();
        const b = String(betweenMatch[2] || '').trim();
        if (a.length >= 2 && b.length >= 2) return [a, b];
    }
    const vsMatch = raw.match(/\b(.+?)\s+(?:vs|v\/s|versus)\s+(.+?)(?:[?.!]|$)/i);
    if (vsMatch) {
        const a = String(vsMatch[1] || '').trim();
        const b = String(vsMatch[2] || '').trim();
        if (a.length >= 2 && b.length >= 2) return [a, b];
    }
    return null;
}

function buildPricingComparisonText(a, b, userQuestion, includeRecommendation) {
    const priceA = a && a.price ? a.price : 'Not listed';
    const priceB = b && b.price ? b.price : 'Not listed';
    const featA = Array.isArray(a && a.features) ? a.features.slice(0, 4).join(', ') : '';
    const featB = Array.isArray(b && b.features) ? b.features.slice(0, 4).join(', ') : '';
    const parts = [
        `${a.name} vs ${b.name}:`,
        `- Price: ${priceA} vs ${priceB}`,
        `- Key features: ${featA || 'Not specified'} vs ${featB || 'Not specified'}`
    ];
    if (includeRecommendation) {
        const lc = String(userQuestion || '').toLowerCase();
        const priceNumA = parseNumberFromText(priceA);
        const priceNumB = parseNumberFromText(priceB);
        let pick = null;
        if ((lc.includes('budget') || lc.includes('cheaper') || lc.includes('low cost')) && priceNumA != null && priceNumB != null) {
            pick = priceNumA <= priceNumB ? a : b;
        } else if (lc.includes('feature') || lc.includes('advanced') || lc.includes('scale') || lc.includes('enterprise')) {
            const fa = Array.isArray(a.features) ? a.features.length : 0;
            const fb = Array.isArray(b.features) ? b.features.length : 0;
            pick = fa >= fb ? a : b;
        } else if (priceNumA != null && priceNumB != null) {
            pick = priceNumA <= priceNumB ? a : b;
        }
        if (pick) {
            parts.push(`- Recommendation: ${pick.name} looks like a better fit based on your context.`);
        }
    }
    return parts.join('\n');
}

function buildServiceComparisonText(a, b, includeRecommendation) {
    const descA = a && a.description ? a.description : 'Not specified';
    const descB = b && b.description ? b.description : 'Not specified';
    const parts = [
        `${a.name} vs ${b.name}:`,
        `- Summary: ${descA} vs ${descB}`
    ];
    if (includeRecommendation) {
        parts.push(`- Recommendation: Choose the one closer to your primary use-case or channel focus.`);
    }
    return parts.join('\n');
}

function findDirectNameMatches(products, userQuery) {
    const qNorm = normalizeForDirectNameMatch(userQuery);
    if (!qNorm) return [];
    const qWords = qNorm.split(" ");
    if (qWords.length < 3) return [];
    const matches = [];
    for (const p of products) {
        const nameNorm = normalizeForDirectNameMatch(p.name);
        if (!nameNorm) continue;
        const nameWords = nameNorm.split(" ");
        const overlap = qWords.filter(w => nameWords.includes(w));
        const minWords = Math.min(qWords.length, nameWords.length);
        if (overlap.length >= Math.max(1, minWords - 1)) {
            matches.push(p);
        }
    }
    return matches;
}

function parseNumberFromText(v) {
    const s = String(v == null ? "" : v);
    const cleaned = s.replace(/[,₹]/g, " ").replace(/rs\.?/gi, " ").replace(/[^\d.]+/g, " ").trim();
    const m = cleaned.match(/\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
}

function normalizeText(v) {
    return String(v == null ? "" : v).toLowerCase().replace(/\s+/g, " ").trim();
}

function getProductPriceNumber(p) {
    if (!p) return null;
    const n = Number(p.numericPrice);
    if (Number.isFinite(n) && n > 0) return n;
    const parsed = parseNumberFromText(p.price);
    return parsed != null ? parsed : null;
}

function getProductOriginalPriceNumber(p) {
    if (!p) return null;
    const n = Number(p.originalNumericPrice);
    if (Number.isFinite(n) && n > 0) return n;
    const parsed = parseNumberFromText(p.originalPrice);
    return parsed != null ? parsed : null;
}

function getDiscountPercent(p) {
    const cur = getProductPriceNumber(p);
    const orig = getProductOriginalPriceNumber(p);
    if (!cur || !orig || orig <= 0 || cur >= orig) return null;
    const pct = ((orig - cur) / orig) * 100;
    return Number.isFinite(pct) ? pct : null;
}

function extractSizeValues(p) {
    const raw = Array.isArray(p && p.sizes) ? p.sizes : [];
    const out = [];
    for (const s of raw) {
        const name = s && s.name != null ? String(s.name).trim() : "";
        if (name) out.push(name);
    }
    return out;
}

function extractNumericSizeValues(p) {
    const raw = extractSizeValues(p);
    const out = [];
    for (const s of raw) {
        const m = String(s || "").match(/(\d{1,2}(?:\.\d+)?)/);
        if (!m) continue;
        const n = Number(m[1]);
        if (!Number.isFinite(n)) continue;
        out.push(n);
    }
    return out;
}

function extractColorValues(p) {
    const raw = Array.isArray(p && p.colors) ? p.colors : [];
    const out = [];
    for (const c of raw) {
        const name = c != null ? String(c).trim() : "";
        if (name) out.push(name);
    }
    return out;
}

function anyOverlap(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return false;
    const setB = new Set(b.map(x => normalizeText(x)));
    for (const x of a) {
        if (setB.has(normalizeText(x))) return true;
    }
    return false;
}

function productSearchText(p) {
    const parts = [
        p && p.name,
        p && p.description,
        p && p.material,
        p && p.fit,
        p && p.design,
        p && p.durability,
        p && p.comfort,
        p && p.care,
        p && p.detailsText,
        p && p.manufacturingInfo,
        Array.isArray(p && p.shippingBadges) ? p.shippingBadges.join(" ") : "",
        Array.isArray(p && p.tags) ? p.tags.join(" ") : "",
        Array.isArray(p && p.collections) ? p.collections.join(" ") : "",
        Array.isArray(p && p.promotions) ? p.promotions.join(" ") : "",
        Array.isArray(p && p.skus) ? p.skus.join(" ") : "",
        Array.isArray(p && p.codes) ? p.codes.join(" ") : "",
        Array.isArray(p && p.attributes) ? p.attributes.join(" ") : ""
    ].filter(Boolean);
    return normalizeText(parts.join(" "));
}

function normalizeRange(min, max, lowerBound = -Infinity, upperBound = Infinity) {
    const a = min != null && Number.isFinite(Number(min)) ? Number(min) : null;
    const b = max != null && Number.isFinite(Number(max)) ? Number(max) : null;
    if (a == null && b == null) return null;
    let lo = a;
    let hi = b;
    if (lo != null && hi != null && lo > hi) {
        const t = lo;
        lo = hi;
        hi = t;
    }
    if (lo != null) lo = Math.max(lowerBound, Math.min(upperBound, lo));
    if (hi != null) hi = Math.max(lowerBound, Math.min(upperBound, hi));
    if (lo != null && hi != null && lo > hi) return null;
    return { min: lo, max: hi };
}

function mergeRanges(primary, fallback) {
    const p = primary && typeof primary === "object" ? primary : null;
    const f = fallback && typeof fallback === "object" ? fallback : null;
    if (!p && !f) return null;
    const min = p && p.min != null ? p.min : (f ? f.min : null);
    const max = p && p.max != null ? p.max : (f ? f.max : null);
    return { min, max };
}

function detectPriceRangeFromQueryText(text) {
    const s = String(text || "");
    if (!s) return null;
    const normalized = s.replace(/[,]/g, " ");
    const rangePatterns = [
        /\b(?:between|from)\s*(?:₹|rs\.?\s*)?(\d{3,7})\s*(?:and|to|-)\s*(?:₹|rs\.?\s*)?(\d{3,7})\b/i,
        /\b(?:₹|rs\.?\s*)\s*(\d{3,7})\s*(?:and|to|-)\s*(?:₹|rs\.?\s*)\s*(\d{3,7})\b/i,
        /\b(\d{3,7})\s*(?:and|to|-)\s*(\d{3,7})\s*(?:₹|rs\.?|rupees?)\b/i,
        /\b(\d{3,7})\s*(?:s|se|to|-)\s*(\d{3,7})\s*(?:(?:k|ke)\s*)?(?:beech|bich|bichh|bic?h|tak|tk)?\b/i
    ];
    for (const re of rangePatterns) {
        const m = normalized.match(re);
        if (!m) continue;
        const a = parseInt(m[1], 10);
        const b = parseInt(m[2], 10);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        const r = normalizeRange(a, b, 0, 10000000);
        if (r) return r;
    }
    const maxPatterns = [
        /\b(?:under|below|upto|up\s*to|within|less\s+than|<=)\s*(?:₹|rs\.?\s*)?(\d{3,7})\b/i,
        /\b(?:₹|rs\.?\s*)\s*(?:under|below|upto|up\s*to|within|less\s+than)\s*(\d{3,7})\b/i
    ];
    for (const re of maxPatterns) {
        const m = normalized.match(re);
        if (!m) continue;
        const v = parseInt(m[1], 10);
        if (!Number.isFinite(v)) continue;
        const r = normalizeRange(null, v, 0, 10000000);
        if (r) return r;
    }
    const minPatterns = [
        /\b(?:above|over|more\s+than|at\s*least|minimum|min|>=)\s*(?:₹|rs\.?\s*)?(\d{3,7})\b/i,
        /\b(?:₹|rs\.?\s*)\s*(?:above|over|more\s+than|at\s*least|minimum|min)\s*(\d{3,7})\b/i
    ];
    for (const re of minPatterns) {
        const m = normalized.match(re);
        if (!m) continue;
        const v = parseInt(m[1], 10);
        if (!Number.isFinite(v)) continue;
        const r = normalizeRange(v, null, 0, 10000000);
        if (r) return r;
    }
    return null;
}

function detectRatingRangeFromQueryText(text) {
    const s = String(text || "");
    if (!s) return null;
    const hint = /(rating|ratings|stars?|\/\s*5|★|⭐)/i.test(s);
    if (!hint) return null;
    const normalized = s.replace(/[,]/g, " ");
    const rangePatterns = [
        /\b(?:between|from)\s*(\d(?:\.\d+)?)\s*(?:and|to|-|s|se)\s*(\d(?:\.\d+)?)\s*(?:\/\s*5)?\s*(?:stars?|rating)?\b/i,
        /\b(\d(?:\.\d+)?)\s*(?:to|-|s|se)\s*(\d(?:\.\d+)?)\s*(?:\/\s*5)?\s*(?:stars?|rating)\b/i
    ];
    for (const re of rangePatterns) {
        const m = normalized.match(re);
        if (!m) continue;
        const a = Number(m[1]);
        const b = Number(m[2]);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        const r = normalizeRange(a, b, 0, 5);
        if (r) return r;
    }
    const plus = normalized.match(/\b(\d(?:\.\d+)?)\s*\+\s*(?:stars?|rating)\b/i);
    if (plus) {
        const v = Number(plus[1]);
        if (Number.isFinite(v)) {
            const r = normalizeRange(v, null, 0, 5);
            if (r) return r;
        }
    }
    const maxPatterns = [
        /\b(?:under|below|<=|at\s*most|maximum|max)\s*(\d(?:\.\d+)?)\s*(?:stars?|rating|\/\s*5)\b/i
    ];
    for (const re of maxPatterns) {
        const m = normalized.match(re);
        if (!m) continue;
        const v = Number(m[1]);
        if (!Number.isFinite(v)) continue;
        const r = normalizeRange(null, v, 0, 5);
        if (r) return r;
    }
    const minPatterns = [
        /\b(?:above|over|>=|at\s*least|minimum|min)\s*(\d(?:\.\d+)?)\s*(?:stars?|rating|\/\s*5)\b/i
    ];
    for (const re of minPatterns) {
        const m = normalized.match(re);
        if (!m) continue;
        const v = Number(m[1]);
        if (!Number.isFinite(v)) continue;
        const r = normalizeRange(v, null, 0, 5);
        if (r) return r;
    }
    return null;
}

function detectDiscountPercentRangeFromQueryText(text) {
    const s = String(text || "");
    if (!s) return null;
    const hint = /(%|discount|off|sale|offer)/i.test(s);
    if (!hint) return null;
    const normalized = s.replace(/[,]/g, " ");
    const rangePatterns = [
        /\b(\d{1,2})\s*%\s*(?:to|-|and|s|se)\s*(\d{1,2})\s*%\s*(?:off|discount)?\b/i,
        /\b(?:between|from)\s*(\d{1,2})\s*%\s*(?:and|to|-|s|se)\s*(\d{1,2})\s*%\s*(?:off|discount)?\b/i
    ];
    for (const re of rangePatterns) {
        const m = normalized.match(re);
        if (!m) continue;
        const a = parseInt(m[1], 10);
        const b = parseInt(m[2], 10);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        const r = normalizeRange(a, b, 0, 100);
        if (r) return r;
    }
    const maxPatterns = [
        /\b(?:under|below|<=|upto|up\s*to|at\s*most|maximum|max)\s*(\d{1,2})\s*%\s*(?:off|discount)?\b/i
    ];
    for (const re of maxPatterns) {
        const m = normalized.match(re);
        if (!m) continue;
        const v = parseInt(m[1], 10);
        if (!Number.isFinite(v)) continue;
        const r = normalizeRange(null, v, 0, 100);
        if (r) return r;
    }
    const minPatterns = [
        /\b(?:above|over|>=|at\s*least|minimum|min)\s*(\d{1,2})\s*%\s*(?:off|discount)?\b/i
    ];
    for (const re of minPatterns) {
        const m = normalized.match(re);
        if (!m) continue;
        const v = parseInt(m[1], 10);
        if (!Number.isFinite(v)) continue;
        const r = normalizeRange(v, null, 0, 100);
        if (r) return r;
    }
    return null;
}

function detectSizeRangeFromQueryText(text) {
    const s = String(text || "");
    if (!s) return null;
    const hint = /\bsize\b|\buk\b|\beu\b/i.test(s);
    if (!hint) return null;
    const normalized = s.replace(/[,]/g, " ");
    const rangePatterns = [
        /\b(?:size|uk|eu)\s*(?:between|from)?\s*(\d{1,2}(?:\.\d+)?)\s*(?:and|to|-|s|se)\s*(\d{1,2}(?:\.\d+)?)\b/i,
        /\b(\d{1,2}(?:\.\d+)?)\s*(?:and|to|-|s|se)\s*(\d{1,2}(?:\.\d+)?)\s*(?:size|uk|eu)\b/i
    ];
    for (const re of rangePatterns) {
        const m = normalized.match(re);
        if (!m) continue;
        const a = Number(m[1]);
        const b = Number(m[2]);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        const r = normalizeRange(a, b, 0, 50);
        if (r) return r;
    }
    const maxPatterns = [
        /\b(?:size|uk|eu)\s*(?:under|below|<=|upto|up\s*to|at\s*most|maximum|max)\s*(\d{1,2}(?:\.\d+)?)\b/i
    ];
    for (const re of maxPatterns) {
        const m = normalized.match(re);
        if (!m) continue;
        const v = Number(m[1]);
        if (!Number.isFinite(v)) continue;
        const r = normalizeRange(null, v, 0, 50);
        if (r) return r;
    }
    const minPatterns = [
        /\b(?:size|uk|eu)\s*(?:above|over|>=|at\s*least|minimum|min)\s*(\d{1,2}(?:\.\d+)?)\b/i
    ];
    for (const re of minPatterns) {
        const m = normalized.match(re);
        if (!m) continue;
        const v = Number(m[1]);
        if (!Number.isFinite(v)) continue;
        const r = normalizeRange(v, null, 0, 50);
        if (r) return r;
    }
    return null;
}

function stripRangeClauses(text) {
    const s = String(text || "");
    if (!s) return "";
    const patterns = [
        /\b(?:between|from)\s*(?:₹|rs\.?\s*)?\d{3,7}\s*(?:and|to|-)\s*(?:₹|rs\.?\s*)?\d{3,7}\b/ig,
        /\b(?:₹|rs\.?\s*)\s*\d{3,7}\s*(?:and|to|-)\s*(?:₹|rs\.?\s*)\s*\d{3,7}\b/ig,
        /\b\d{3,7}\s*(?:s|se|to|-)\s*\d{3,7}\s*(?:(?:k|ke)\s*)?(?:beech|bich|bichh|bic?h|tak|tk)?\b/ig,
        /\b(?:under|below|upto|up\s*to|within|less\s+than|above|over|more\s+than|at\s*least|minimum|min|>=|<=)\s*(?:₹|rs\.?\s*)?\d{3,7}\b/ig,
        /\b(?:between|from)\s*\d(?:\.\d+)?\s*(?:and|to|-|s|se)\s*\d(?:\.\d+)?\s*(?:\/\s*5)?\s*(?:stars?|rating)\b/ig,
        /\b\d(?:\.\d+)?\s*(?:to|-|s|se)\s*\d(?:\.\d+)?\s*(?:\/\s*5)?\s*(?:stars?|rating)\b/ig,
        /\b(?:under|below|<=|above|over|>=|at\s*least|minimum|min|max|maximum|at\s*most)\s*\d(?:\.\d+)?\s*(?:stars?|rating|\/\s*5)\b/ig,
        /\b(\d(?:\.\d+)?)\s*\+\s*(?:stars?|rating)\b/ig,
        /\b(?:size|uk|eu)\s*(?:between|from)?\s*\d{1,2}(?:\.\d+)?\s*(?:and|to|-|s|se)\s*\d{1,2}(?:\.\d+)?\b/ig,
        /\b\d{1,2}(?:\.\d+)?\s*(?:and|to|-|s|se)\s*\d{1,2}(?:\.\d+)?\s*(?:size|uk|eu)\b/ig,
        /\b(?:size|uk|eu)\s*(?:under|below|<=|above|over|>=|at\s*least|minimum|min|max|maximum|upto|up\s*to|at\s*most)\s*\d{1,2}(?:\.\d+)?\b/ig,
        /\b(\d{1,2})\s*%\s*(?:to|-|and|s|se)\s*(\d{1,2})\s*%\s*(?:off|discount)?\b/ig,
        /\b(?:under|below|<=|above|over|>=|at\s*least|minimum|min|max|maximum|upto|up\s*to|at\s*most)\s*\d{1,2}\s*%\s*(?:off|discount)?\b/ig
    ];
    let out = s;
    for (const re of patterns) out = out.replace(re, " ");
    out = out.replace(/\s+/g, " ").trim();
    return out;
}

function hasAnyAdvancedFilters(obj) {
    if (!obj || typeof obj !== "object") return false;
    if (Array.isArray(obj.colors) && obj.colors.length) return true;
    if (Array.isArray(obj.sizes) && obj.sizes.length) return true;
    if (obj.onSale === true) return true;
    if (Array.isArray(obj.offerKeywords) && obj.offerKeywords.length) return true;
    if (Array.isArray(obj.includeTerms) && obj.includeTerms.length) return true;
    if (Array.isArray(obj.excludeTerms) && obj.excludeTerms.length) return true;
    if (obj.coupon) return true;
    const r = [obj.price, obj.rating, obj.discountPercent, obj.sizeRange].filter(Boolean);
    for (const x of r) {
        if (x && (x.min != null || x.max != null)) return true;
    }
    return false;
}

function dedupStringArray(arr) {
    const raw = Array.isArray(arr) ? arr : [];
    const out = [];
    const seen = new Set();
    for (const v of raw) {
        const s = v != null ? String(v).trim() : "";
        if (!s) continue;
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
    }
    return out;
}

function mergeStringArrays(a, b) {
    return dedupStringArray([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]);
}

function shouldTryLLMFilterExtraction(text) {
    const s = String(text || "");
    if (!s) return false;
    if (s.length > 260) return false;
    return /(color|colour|size|uk|eu|rs\.?|₹|rupees?|price|budget|rating|stars?|\/\s*5|discount|%|offer|offers|coupon|promo|festive|sale|on\s*sale|without|avoid|no\s+\w+|not\s+\w+|vegan|cruelty[\s-]*free|leather)/i.test(s);
}

function detectProductCodeFromUserText(text) {
    const s = String(text || "");
    if (!s) return null;
    const m1 = s.match(/\(\s*(\d{3,6})\s*\)/);
    if (m1) return m1[1];
    const m2 = s.match(/\b(?:code|sku|article|style|product)\s*[:#-]?\s*(\d{3,6})\b/i);
    if (m2) return m2[1];
    const m3 = s.match(/^\s*(\d{3,6})\s*$/);
    if (m3) return m3[1];
    return null;
}

function inferProductAttributes(p) {
    const parts = [
        p && p.name,
        p && p.category,
        p && p.description,
        p && p.material,
        p && p.fit,
        p && p.design,
        p && p.durability,
        p && p.comfort,
        p && p.care,
        p && p.detailsText,
        p && p.manufacturingInfo,
        Array.isArray(p && p.tags) ? p.tags.join(" ") : "",
        Array.isArray(p && p.collections) ? p.collections.join(" ") : "",
        Array.isArray(p && p.promotions) ? p.promotions.join(" ") : "",
        Array.isArray(p && p.shippingBadges) ? p.shippingBadges.join(" ") : ""
    ].filter(Boolean);
    const text = normalizeText(parts.join(" "));
    if (!text) return [];
    const out = [];
    const push = (v) => {
        const s = String(v || "").trim();
        if (!s) return;
        out.push(s);
    };
    if (/\bleather\b/i.test(text)) push("leather");
    if (/\b(vegan|cruelty[\s-]*free)\b/i.test(text)) push("vegan");
    if (/\bsynthetic\b/i.test(text) || /\bpu\b/i.test(text) || /\bfaux\b/i.test(text)) push("synthetic");
    if (/\bcomfort\b/i.test(text) || /\bcushion\b/i.test(text) || /\bpadded\b/i.test(text) || /\bsoft\b/i.test(text)) push("comfort");
    if (/\boffice\b/i.test(text) || /\boffice\s*wear\b/i.test(text)) push("office");
    if (/\bformal\b/i.test(text)) push("formal");
    if (/\bethnic\b/i.test(text) || /\bbrocade\b/i.test(text)) push("ethnic");
    if (/\bsports?\b/i.test(text)) push("sports");
    if (/\bparty\b/i.test(text) || /\bwedding\b/i.test(text)) push("party");
    if (/\bblock\s*heel\b/i.test(text)) push("block heel");
    if (/\bkitten\s*heel\b/i.test(text)) push("kitten heel");
    if (/\bplatforms?\b/i.test(text)) push("platform");
    if (/\bflats?\b/i.test(text)) push("flats");
    if (/\bheels?\b/i.test(text)) push("heels");
    return dedupStringArray(out);
}

function normalizeLLMFilters(raw) {
    const x = raw && typeof raw === "object" ? raw : {};
    const colors = dedupStringArray(x.colors);
    const sizes = dedupStringArray(x.sizes);
    const offerKeywords = dedupStringArray(x.offerKeywords);
    const includeTerms = dedupStringArray(x.includeTerms);
    const excludeTerms = dedupStringArray(x.excludeTerms);
    const coupon = x.coupon != null ? String(x.coupon).trim() : "";
    const onSale = x.onSale === true ? true : undefined;
    const sortBy = x.sortBy != null ? String(x.sortBy).trim() : "";
    const query = x.query != null ? String(x.query).trim() : "";
    const limit = Number.isFinite(Number(x.limit)) ? Math.max(1, Math.min(200, Number(x.limit))) : null;
    const price = x.price && typeof x.price === "object" ? normalizeRange(x.price.min, x.price.max, 0, 10000000) : null;
    const rating = x.rating && typeof x.rating === "object" ? normalizeRange(x.rating.min, x.rating.max, 0, 5) : null;
    const discountPercent = x.discountPercent && typeof x.discountPercent === "object" ? normalizeRange(x.discountPercent.min, x.discountPercent.max, 0, 100) : null;
    const sizeRange = x.sizeRange && typeof x.sizeRange === "object" ? normalizeRange(x.sizeRange.min, x.sizeRange.max, 0, 50) : null;
    return { colors, sizes, offerKeywords, includeTerms, excludeTerms, coupon, onSale, sortBy, query, limit, price, rating, discountPercent, sizeRange };
}

async function extractFiltersWithLLM(userQuery, userState, userId) {
    if (!shouldTryLLMFilterExtraction(userQuery)) return null;
    const prefs = userState && userState.preferences && typeof userState.preferences === "object" ? userState.preferences : {};
    const prefSummary = {
        size: prefs.size || null,
        colors: Array.isArray(prefs.colors) ? prefs.colors.slice(0, 6) : [],
        budget: prefs.budget || null,
        styles: Array.isArray(prefs.styles) ? prefs.styles.slice(0, 6) : []
    };
    const system = [
        `Extract product search filters for ${BRAND_NAME} products as one JSON object.`,
        "Keys: query, colors, sizes, sizeRange, price, rating, discountPercent, onSale, offerKeywords, coupon, sortBy, limit, includeTerms, excludeTerms.",
        "query: remaining free-text intent (e.g. office sneakers white sole).",
        "Ranges (sizeRange/price/rating/discountPercent): { min, max } or null.",
        "onSale: true only if user clearly wants offers/discount/sale; else false.",
        "offerKeywords: festive/offer/sale words. coupon: explicit coupon code.",
        "includeTerms: must-have words/features. excludeTerms: things user wants to avoid.",
        "sortBy: price_low_to_high, price_high_to_low, rating_high_to_low or empty string.",
        "limit: small integer only when user clearly asks for specific count.",
        "If unsure, leave fields empty and keep text in query. No extra text, only JSON."
    ].join(" ");
    const user = [
        `userQuery: ${String(userQuery || "").trim().slice(0, 280)}`,
        `knownPreferences: ${JSON.stringify(prefSummary).slice(0, 320)}`
    ].join(" ");
    try {
        const messages = [
            { role: "system", content: system },
            { role: "user", content: user }
        ];
        const completion = await openai.chat.completions.create({
            model: GPT_MODEL,
            messages,
            max_completion_tokens: 80,
            temperature: 0
        });
        logTokenUsage("product_filters", { model: GPT_MODEL, userId }, completion, messages);
        const choice = completion && completion.choices && completion.choices[0] ? completion.choices[0] : {};
        const msg = choice.message && typeof choice.message.content === "string" ? choice.message.content : "";
        const jsonStr = extractFirstJsonObject(msg);
        if (!jsonStr) return null;
        const parsed = JSON.parse(jsonStr);
        return normalizeLLMFilters(parsed);
    } catch (e) {
        return null;
    }
}

async function search_products(args, socket) {
    const a = args && typeof args === "object" ? args : {};
    const userQuery = a.userQuery != null ? String(a.userQuery) : "";
    const sortBy = a.sortBy != null ? String(a.sortBy) : undefined;
    const colors = Array.isArray(a.colors) ? a.colors.map(x => String(x)) : [];
    const sizes = Array.isArray(a.sizes) ? a.sizes.map(x => String(x)) : [];
    const offerKeywords = Array.isArray(a.offerKeywords) ? a.offerKeywords.map(x => String(x)) : [];
    const coupon = a.coupon != null ? String(a.coupon) : "";
    const onSale = a.onSale === true;
    const limit = Number.isFinite(Number(a.limit)) ? Math.max(1, Math.min(200, Number(a.limit))) : null;

    try {
        logToolCall("search_products", {
            userId: socket && socket.user_id ? socket.user_id : null,
            source: "rule_engine",
            inputChars: userQuery.length
        });
    } catch (e) {}

    const userState = getUserState(socket.user_id);
    try {
        const cacheInfo = getProductCacheInfo();
        const isCold = !cacheInfo.lastFetched || !Array.isArray(cacheInfo.data) || cacheInfo.data.length === 0;
        const nowMs = Date.now();
        const lastNotify = Number(userState.lastCatalogLoadNotifyAt) || 0;
        if (isCold && (nowMs - lastNotify) > 15000) {
            await sendMessage(socket, botConfig.phrases.catalog_loading, socket.user_id);
            userState.lastCatalogLoadNotifyAt = nowMs;
            setUserState(socket.user_id, userState);
        }
    } catch (e) {}
    const llm = await extractFiltersWithLLM(userQuery, userState, socket.user_id);
    const llmLimit = llm && Number.isFinite(Number(llm.limit)) ? Math.max(1, Math.min(200, Number(llm.limit))) : null;
    const finalLimit = limit == null ? llmLimit : limit;

    const inferredPrice = detectPriceRangeFromQueryText(userQuery);
    const inferredRating = detectRatingRangeFromQueryText(userQuery);
    const inferredDiscount = detectDiscountPercentRangeFromQueryText(userQuery);
    const inferredSizeRange = detectSizeRangeFromQueryText(userQuery);
    const baseQuery = llm && llm.query ? llm.query : userQuery;
    const cleanedQuery = stripRangeClauses(baseQuery) || baseQuery;

    const providedPrice = a.price && typeof a.price === "object" ? normalizeRange(a.price.min, a.price.max, 0, 10000000) : null;
    const providedRating = a.rating && typeof a.rating === "object" ? normalizeRange(a.rating.min, a.rating.max, 0, 5) : null;
    const providedDiscount = a.discountPercent && typeof a.discountPercent === "object" ? normalizeRange(a.discountPercent.min, a.discountPercent.max, 0, 100) : null;
    const providedSizeRange = a.sizeRange && typeof a.sizeRange === "object" ? normalizeRange(a.sizeRange.min, a.sizeRange.max, 0, 50) : null;

    const llmPrice = llm && llm.price ? llm.price : null;
    const llmRating = llm && llm.rating ? llm.rating : null;
    const llmDiscount = llm && llm.discountPercent ? llm.discountPercent : null;
    const llmSizeRange = llm && llm.sizeRange ? llm.sizeRange : null;

    const adv = {
        query: cleanedQuery,
        colors: mergeStringArrays(colors, llm ? llm.colors : []),
        sizes: mergeStringArrays(sizes, llm ? llm.sizes : []),
        onSale: onSale || (llm && llm.onSale === true),
        offerKeywords: mergeStringArrays(offerKeywords, llm ? llm.offerKeywords : []),
        includeTerms: mergeStringArrays(Array.isArray(a.includeTerms) ? a.includeTerms.map(x => String(x)) : [], llm ? llm.includeTerms : []),
        excludeTerms: mergeStringArrays(Array.isArray(a.excludeTerms) ? a.excludeTerms.map(x => String(x)) : [], llm ? llm.excludeTerms : []),
        coupon: coupon || (llm && llm.coupon ? llm.coupon : ""),
        sortBy: sortBy || (llm && llm.sortBy ? llm.sortBy : "") || "relevance",
        limit: finalLimit == null ? undefined : finalLimit,
        price: normalizeRange(mergeRanges(mergeRanges(providedPrice, llmPrice), inferredPrice)?.min, mergeRanges(mergeRanges(providedPrice, llmPrice), inferredPrice)?.max, 0, 10000000),
        rating: normalizeRange(mergeRanges(mergeRanges(providedRating, llmRating), inferredRating)?.min, mergeRanges(mergeRanges(providedRating, llmRating), inferredRating)?.max, 0, 5),
        discountPercent: normalizeRange(mergeRanges(mergeRanges(providedDiscount, llmDiscount), inferredDiscount)?.min, mergeRanges(mergeRanges(providedDiscount, llmDiscount), inferredDiscount)?.max, 0, 100),
        sizeRange: normalizeRange(mergeRanges(mergeRanges(providedSizeRange, llmSizeRange), inferredSizeRange)?.min, mergeRanges(mergeRanges(providedSizeRange, llmSizeRange), inferredSizeRange)?.max, 0, 50)
    };

    if (hasAnyAdvancedFilters(adv)) {
        try {
            return await search_product(adv, socket);
        } catch (err) {
            try {
                console.error("SEARCH_PRODUCT_ERROR", err && err.stack ? err.stack : err);
            } catch (e) {}
        }
    }

    try {
        return await searchProducts({
            userQuery,
            sortBy,
            socket,
            getLiveProducts,
            getProductCodeStatus,
            getUserState,
            userStates,
            sendMessage,
            vectorSearch,
            ranker,
            callOpenAI,
            show_more_products
        });
    } catch (err) {
        try {
            console.error("SEARCH_PRODUCTS_ERROR", err && err.stack ? err.stack : err);
        } catch (e) {}
        try {
            await sendMessage(socket, "Thoda issue aa gaya, main simple list se kuch options dikha raha hoon.", socket.user_id);
        } catch (e) {}
        try {
            const products = await getLiveProducts();
            const st = getUserState(socket.user_id);
            const list = Array.isArray(products) ? products.slice(0, 12) : [];
            st.lastSearchResults = list;
            st.lastQueryProducts = list;
            st.productViewIndex = 0;
            userStates.set(socket.user_id, st);
            await show_more_products({}, socket);
            return JSON.stringify({
                success: true,
                summary: `Showing ${list.length} products from basic fallback list.`,
                totalMatches: list.length
            });
        } catch (e) {
            return JSON.stringify({ success: false, error: "basic_fallback_failed" });
        }
    }
}

async function search_product(args, socket) {
    const a = args && typeof args === "object" ? args : {};
    const query = a.query != null ? String(a.query) : "";
    const name = a.name != null ? String(a.name) : "";
    const description = a.description != null ? String(a.description) : "";
    const sku = a.sku != null ? String(a.sku) : "";
    const code = a.code != null ? String(a.code) : "";
    const colors = Array.isArray(a.colors) ? a.colors.map(x => String(x)) : [];
    const sizes = Array.isArray(a.sizes) ? a.sizes.map(x => String(x)) : [];
    const includeTerms = Array.isArray(a.includeTerms) ? a.includeTerms.map(x => String(x)) : [];
    const excludeTerms = Array.isArray(a.excludeTerms) ? a.excludeTerms.map(x => String(x)) : [];
    const sizeMin = a.sizeRange && a.sizeRange.min != null ? Number(a.sizeRange.min) : null;
    const sizeMax = a.sizeRange && a.sizeRange.max != null ? Number(a.sizeRange.max) : null;
    const offerKeywords = Array.isArray(a.offerKeywords) ? a.offerKeywords.map(x => String(x)) : [];
    const coupon = a.coupon != null ? String(a.coupon) : "";
    const sortBy = a.sortBy != null ? String(a.sortBy) : "relevance";
    const limit = Number.isFinite(Number(a.limit)) ? Math.max(1, Math.min(200, Number(a.limit))) : 60;
    const priceMin = a.price && a.price.min != null ? Number(a.price.min) : null;
    const priceMax = a.price && a.price.max != null ? Number(a.price.max) : null;
    const ratingMin = a.rating && a.rating.min != null ? Number(a.rating.min) : null;
    const ratingMax = a.rating && a.rating.max != null ? Number(a.rating.max) : null;
    const discMin = a.discountPercent && a.discountPercent.min != null ? Number(a.discountPercent.min) : null;
    const discMax = a.discountPercent && a.discountPercent.max != null ? Number(a.discountPercent.max) : null;
    const onSale = a.onSale === true;

    const products = await getLiveProducts();
    const productMap = new Map(products.map(p => [String(p.id), p]));
    let semanticOrder = [];
    let semanticScore = new Map();
    const originalQuery = String(query || "").trim();
    const detectedCode = code || detectProductCodeFromUserText(originalQuery);
    if (detectedCode) {
        const status = getProductCodeStatus(detectedCode);
        if (status === "out_of_stock") {
            await sendMessage(socket, `Is code (${detectedCode}) wali product abhi out of stock hai. Meanwhile, neeche closest options dekh lo:`, socket.user_id);
        } else if (status === "not_found") {
            await sendMessage(socket, `Is code (${detectedCode}) ka product is time catalog me nahi mil raha. Neeche closest options dekh lo:`, socket.user_id);
        }
    }
    const catalogTokenSet = (() => {
        const set = new Set();
        for (const p of products) {
            const text = productSearchText(p);
            if (!text) continue;
            const parts = text.split(" ");
            for (const t of parts) if (t && t.length >= 4) set.add(t);
        }
        return set;
    })();
    const qWordsAll = normalizeText(originalQuery).split(" ").filter(t => t.length >= 3);
    const missingTokensAll = qWordsAll.filter(t => t.length >= 5 && /^[a-z]+$/.test(t) && !catalogTokenSet.has(t));
    const missingTokens = Array.from(new Set(missingTokensAll));
    const qWordsEffective = qWordsAll.filter(t => !missingTokens.includes(t));
    const qTrim = qWordsEffective.join(" ").trim();
    if (qTrim) {
        const semLimit = Math.max(20, Math.min(140, limit * 2));
        try {
            const sem = await vectorSearch.semanticSearch(qTrim, semLimit);
            semanticOrder = sem.map(r => String(r.id));
            semanticScore = new Map(sem.map(r => [String(r.id), typeof r.score === "number" ? r.score : 0]));
        } catch (e) {
            semanticOrder = [];
            semanticScore = new Map();
        }
    }

    const tokenQuery = normalizeText([qTrim, originalQuery, name, description, sku, code, offerKeywords.join(" "), coupon, includeTerms.join(" ")].filter(Boolean).join(" "));
    const tokens = tokenQuery.split(" ").filter(t => t.length >= 3);

    const directMatches = [];
    if (tokens.length) {
        for (const p of products) {
            const text = productSearchText(p);
            if (!text) continue;
            if (tokens.some(t => text.includes(t))) {
                directMatches.push(String(p.id));
            }
        }
    }

    const seen = new Set();
    const candidateIds = [];
    for (const id of semanticOrder) {
        if (!seen.has(id)) {
            seen.add(id);
            candidateIds.push(id);
        }
    }
    for (const id of directMatches) {
        if (!seen.has(id)) {
            seen.add(id);
            candidateIds.push(id);
        }
    }
    if (!candidateIds.length) {
        for (const p of products) candidateIds.push(String(p.id));
    }

    const matchesFilter = (p) => {
        if (!p) return false;
        const text = productSearchText(p);
        const inc = dedupStringArray(includeTerms).map(t => normalizeText(t)).filter(Boolean);
        const exc = dedupStringArray(excludeTerms).map(t => normalizeText(t)).filter(Boolean);
        if (exc.length && exc.some(t => t && text.includes(t))) return false;
        if (inc.length && !inc.every(t => t && text.includes(t))) return false;

        if (name && !normalizeText(p.name).includes(normalizeText(name))) return false;
        if (description && !normalizeText(p.description).includes(normalizeText(description)) && !text.includes(normalizeText(description))) return false;

        if (sku) {
            const v = normalizeText(sku);
            const skus = Array.isArray(p.skus) ? p.skus.map(s => normalizeText(s)) : [];
            if (!skus.some(s => s.includes(v)) && !text.includes(v)) return false;
        }

        if (code) {
            const v = String(code).trim();
            const codes = Array.isArray(p.codes) ? p.codes.map(c => String(c)) : [];
            if (!codes.includes(v) && !text.includes(normalizeText(v))) return false;
        }

        if (colors.length) {
            if (!anyOverlap(colors, extractColorValues(p))) return false;
        }

        if (sizes.length) {
            if (!anyOverlap(sizes, extractSizeValues(p))) return false;
        }

        if (sizeMin != null || sizeMax != null) {
            const nums = extractNumericSizeValues(p);
            if (!nums.length) return false;
            const ok = nums.some(n => (sizeMin == null || n >= sizeMin) && (sizeMax == null || n <= sizeMax));
            if (!ok) return false;
        }

        if (onSale) {
            const disc = getDiscountPercent(p);
            if (!(p.isOnSale === true) && !(disc != null && disc > 0)) return false;
        }

        if (priceMin != null || priceMax != null) {
            const pr = getProductPriceNumber(p);
            if (pr == null) return false;
            if (priceMin != null && pr < priceMin) return false;
            if (priceMax != null && pr > priceMax) return false;
        }

        if (ratingMin != null || ratingMax != null) {
            const r = typeof p.rating === "number" ? p.rating : null;
            if (r == null) return false;
            if (ratingMin != null && r < ratingMin) return false;
            if (ratingMax != null && r > ratingMax) return false;
        }

        if (discMin != null || discMax != null) {
            const d = getDiscountPercent(p);
            if (d == null) return false;
            if (discMin != null && d < discMin) return false;
            if (discMax != null && d > discMax) return false;
        }

        if (offerKeywords.length) {
            const ok = offerKeywords.map(k => normalizeText(k)).filter(Boolean);
            if (ok.length && !ok.some(k => text.includes(k))) return false;
        }

        if (coupon) {
            const c = normalizeText(coupon);
            if (c && !text.includes(c)) return false;
        }

        if (qTrim) {
            const qn = normalizeText(qTrim);
            if (qn && !text.includes(qn) && !semanticScore.has(String(p.id))) return false;
        } else if (originalQuery && missingTokens.length) {
            const fallbackNeedles = normalizeText(originalQuery).split(" ").filter(t => t.length >= 5 && /^[a-z]+$/.test(t));
            const hasAny = fallbackNeedles.some(t => text.includes(t));
            if (fallbackNeedles.length && !hasAny) return false;
        }

        return true;
    };

    const matchesFilterRelaxed = (p) => {
        if (!p) return false;
        const text = productSearchText(p);
        const inc = dedupStringArray(includeTerms).map(t => normalizeText(t)).filter(Boolean);
        const exc = dedupStringArray(excludeTerms).map(t => normalizeText(t)).filter(Boolean);
        if (exc.length && exc.some(t => t && text.includes(t))) return false;
        if (inc.length && !inc.every(t => t && text.includes(t))) return false;

        if (name && !normalizeText(p.name).includes(normalizeText(name))) return false;
        if (description && !normalizeText(p.description).includes(normalizeText(description)) && !text.includes(normalizeText(description))) return false;

        if (sku) {
            const v = normalizeText(sku);
            const skus = Array.isArray(p.skus) ? p.skus.map(s => normalizeText(s)) : [];
            if (!skus.some(s => s.includes(v)) && !text.includes(v)) return false;
        }

        if (code) {
            const v = String(code).trim();
            const codes = Array.isArray(p.codes) ? p.codes.map(c => String(c)) : [];
            if (!codes.includes(v) && !text.includes(normalizeText(v))) return false;
        }

        if (colors.length) {
            if (!anyOverlap(colors, extractColorValues(p))) return false;
        }

        if (sizes.length) {
            if (!anyOverlap(sizes, extractSizeValues(p))) return false;
        }

        if (sizeMin != null || sizeMax != null) {
            const nums = extractNumericSizeValues(p);
            if (!nums.length) return false;
            const ok = nums.some(n => (sizeMin == null || n >= sizeMin) && (sizeMax == null || n <= sizeMax));
            if (!ok) return false;
        }

        if (onSale) {
            const disc = getDiscountPercent(p);
            if (!(p.isOnSale === true) && !(disc != null && disc > 0)) return false;
        }

        if (priceMin != null || priceMax != null) {
            const pr = getProductPriceNumber(p);
            if (pr == null) return false;
            if (priceMin != null && pr < priceMin) return false;
            if (priceMax != null && pr > priceMax) return false;
        }

        if (ratingMin != null || ratingMax != null) {
            const r = typeof p.rating === "number" ? p.rating : null;
            if (r == null) return false;
            if (ratingMin != null && r < ratingMin) return false;
            if (ratingMax != null && r > ratingMax) return false;
        }

        if (discMin != null || discMax != null) {
            const d = getDiscountPercent(p);
            if (d == null) return false;
            if (discMin != null && d < discMin) return false;
            if (discMax != null && d > discMax) return false;
        }

        if (offerKeywords.length) {
            const ok = offerKeywords.map(k => normalizeText(k)).filter(Boolean);
            if (ok.length && !ok.some(k => text.includes(k))) return false;
        }

        if (coupon) {
            const c = normalizeText(coupon);
            if (c && !text.includes(c)) return false;
        }

        return true;
    };

    let filtered = [];
    for (const id of candidateIds) {
        const p = productMap.get(String(id));
        if (matchesFilter(p)) filtered.push(p);
    }

    if (sortBy === "price_low_to_high") {
        filtered.sort((x, y) => (getProductPriceNumber(x) || 0) - (getProductPriceNumber(y) || 0));
    } else if (sortBy === "price_high_to_low") {
        filtered.sort((x, y) => (getProductPriceNumber(y) || 0) - (getProductPriceNumber(x) || 0));
    } else if (sortBy === "rating_high_to_low") {
        filtered.sort((x, y) => (Number(y && y.rating) || 0) - (Number(x && x.rating) || 0));
    } else if (sortBy === "discount_high_to_low") {
        filtered.sort((x, y) => (getDiscountPercent(y) || 0) - (getDiscountPercent(x) || 0));
    } else if (sortBy === "relevance") {
        if (qTrim && semanticScore.size) {
            filtered.sort((x, y) => (semanticScore.get(String(y && y.id)) || 0) - (semanticScore.get(String(x && x.id)) || 0));
        } else {
            try {
                filtered = ranker.rankProducts(filtered, getUserState(socket.user_id), qTrim || name || "");
            } catch (e) { }
        }
    }

    if (filtered.length > limit) filtered = filtered.slice(0, limit);

    if (missingTokens.length) {
        const cats = new Map();
        for (const p of products) {
            const c = p && p.category != null ? String(p.category).trim() : "";
            if (!c) continue;
            const k = c.toLowerCase();
            cats.set(k, (cats.get(k) || 0) + 1);
        }
        const topCats = Array.from(cats.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(x => x[0]);
        let messageText = "";
        const system = [
            `You are a ${BRAND_NAME} catalog assistant.`,
            "User asked for something that is not available in the current catalog.",
            "Reply in the same language as the user (use Hinglish with Latin letters if Hindi).",
            "Under 55 words. Plain text only.",
            `Unavailable request terms: ${missingTokens.slice(0, 4).join(", ")}.`,
            topCats.length ? `We mainly have: ${topCats.join(", ")}.` : "",
            "Say we don't have the requested item and then suggest checking the shown alternatives."
        ].filter(Boolean).join(" ");
        const ai = await safeCallOpenAI(socket.user_id, [{ role: "system", content: system }, { role: "user", content: originalQuery }], false);
        if (ai && ai.success && ai.data?.message?.content) {
            messageText = String(ai.data.message.content || "").trim();
        }
        if (!messageText) {
            messageText = `Sorry, is catalog me "${missingTokens.slice(0, 2).join(", ")}" ka exact match available nahi hai. Lekin humare paas similar footwear options hain—neeche wale products dekh lo.`;
        }
        await sendMessage(socket, messageText, socket.user_id);
    }

    if (filtered.length === 0) {
        const relaxed = [];
        for (const id of candidateIds) {
            const p = productMap.get(String(id));
            if (matchesFilterRelaxed(p)) relaxed.push(p);
        }
        if (relaxed.length) {
            filtered = relaxed.slice(0, Math.max(6, Math.min(12, limit)));
        } else {
            const bySale = products.filter(p => p && p.isOnSale === true);
            const base = bySale.length ? bySale : products.slice();
            base.sort((a, b) => (Number(b && b.rating) || 0) - (Number(a && a.rating) || 0));
            filtered = base.slice(0, Math.max(6, Math.min(12, limit)));
        }
    }

    const st = getUserState(socket.user_id);
    st.lastSearchResults = filtered;
    st.lastQueryProducts = filtered;
    st.productViewIndex = 0;
    userStates.set(socket.user_id, st);
    await show_more_products({}, socket);
    return JSON.stringify({
        success: true,
        summary: `Found ${filtered.length} products with the applied filters.`,
        totalMatches: filtered.length
    });
}

async function show_more_products(args, socket) {
    const currentState = getUserState(socket.user_id);
    const prefs = currentState.preferences || {};
    const prefParts = [];
    if (prefs.size) prefParts.push(`preferred size ${prefs.size}`);
    if (Array.isArray(prefs.colors) && prefs.colors.length) prefParts.push(`preferred colors ${prefs.colors.join(', ')}`);
    if (Array.isArray(prefs.styles) && prefs.styles.length) prefParts.push(`preferred styles or usage ${prefs.styles.join(', ')}`);
    const preferenceSummary = prefParts.length ? `The user has ${prefParts.join('; ')}. Explain briefly why each recommended product matches these preferences.` : `Explain briefly why each recommended product is a good everyday choice for the use-case implied by the conversation.`;
    let lastUserMessage = "";
    if (Array.isArray(currentState.conversationContext)) {
        for (let i = currentState.conversationContext.length - 1; i >= 0; i--) {
            const msg = currentState.conversationContext[i];
            if (msg && msg.role === 'user' && msg.content) {
                lastUserMessage = String(msg.content);
                break;
            }
        }
    }
    const languageInstruction = lastUserMessage
        ? `Detect the language and tone from this user message and respond in that same language or mix (for example Hindi, English, or Hinglish): "${lastUserMessage}". When the detected language is Hindi or Hinglish, write Hindi using English/Latin alphabets only (Hinglish) and do NOT use Devanagari or Hindi script.`
        : `Respond in the same language the user has been using recently (Hindi, English, or Hinglish). When the current language is Hindi or Hinglish, write Hindi using English/Latin alphabets only (Hinglish) and do NOT use Devanagari or Hindi script.`;
    const searchResults = currentState.lastQueryProducts ?? currentState.lastSearchResults;
    const startIndex = currentState.productViewIndex || 0;
    const pageSize = 3;

    try {
        logToolCall("show_more_products", {
            userId: socket && socket.user_id ? socket.user_id : null,
            source: "rule_engine",
            inputChars: 0,
            details: {
                startIndex,
                pageSize,
                totalResults: Array.isArray(searchResults) ? searchResults.length : null
            }
        });
    } catch (e) {}

    if (searchResults === undefined) {
        return { success: false, summary: "No search has been performed yet." };
    }

    const productsToShow = searchResults.slice(startIndex, startIndex + pageSize);
    await enrichProductsWithPageExtras(productsToShow);
    const enrichedProductsToShow = productsToShow.map(p => {
        const normalizedLink = normalizeProductLinkForFrontend(p && p.link);
        return {
            ...p,
            link: normalizedLink
        };
    });

    const nextIndex = startIndex + pageSize;
    const hasMore = nextIndex < searchResults.length;
    const recent = Array.isArray(currentState.recentProductsHistory) ? currentState.recentProductsHistory : [];
    const updatedRecent = [...recent, ...enrichedProductsToShow].slice(-10);
    const viewed = Array.isArray(currentState.viewedProducts) ? currentState.viewedProducts.slice() : [];
    for (const p of enrichedProductsToShow) viewed.push(p);
    while (viewed.length > 20) viewed.shift();
    const displayedHistory = Array.isArray(currentState.displayedProductsHistory) ? currentState.displayedProductsHistory.slice() : [];
    for (const p of enrichedProductsToShow) displayedHistory.push(p);
    while (displayedHistory.length > 500) displayedHistory.shift();
    currentState.productViewIndex = nextIndex;
    currentState.lastDisplayedProducts = enrichedProductsToShow;
    currentState.lastDisplayPageId = Date.now();
    currentState.lastDisplayedStart = startIndex;
    currentState.recentProductsHistory = updatedRecent;
    currentState.viewedProducts = viewed;
    currentState.displayedProductsHistory = displayedHistory;
    userStates.set(socket.user_id, currentState);

    if (enrichedProductsToShow.length === 0) {
        if (startIndex === 0) {
            if (!socket.isWhatsApp) {
                await sendMessage(socket, { type: '__CONTROL_SHOW_MORE__', data: { show: false } }, socket.user_id);
            }
            return { success: true, summary: "No products found for this view." };
        }

        const message = "You've seen all the results for this search!";
        await sendMessage(socket, message, socket.user_id);

        if (!socket.isWhatsApp) {
            await sendMessage(socket, { type: '__CONTROL_SHOW_MORE__', data: { show: false } }, socket.user_id);
        }

        return { success: true, summary: "End of list." };
    }

    if (socket.isWhatsApp) {
        for (const product of enrichedProductsToShow) {
            await sendWhatsAppProductMessage(socket.user_id, product);
        }
    } else {
        await sendMessage(socket, {
            type: '__PRODUCT_CATALOG__',
            data: enrichedProductsToShow,
            meta: { mode: (args && args.catalog_mode) ? args.catalog_mode : 'replace' }
        }, socket.user_id);
    }


    if (!socket.isWhatsApp) {
        await sendMessage(socket, { type: '__CONTROL_SHOW_MORE__', data: { show: hasMore } }, socket.user_id);
    }

    return { success: true, summary: `Displayed products from index ${startIndex} to ${nextIndex - 1}.` };
}

async function normalizeKbQuery(userQuery) {
    const raw = String(userQuery || '').trim();
    const lower = raw.toLowerCase();
    const policyRegex = /(return|refund|exchange|replacement|replace|shipping|delivery|dispatch|courier|shipment|tracking|track|policy|warranty|payment|cod|cancel|order|support|contact|wapas|wapis|wapasi|vapas|vaapas|रिटर्न|रिफंड|एक्सचेंज|पालिसी|पॉलिसी|नीति|शिपिंग|डिलीवरी|ट्रैकिंग|वारंटी|भुगतान|कैंसिल|कैंसल)/i;
    const fallbackRequiresPolicy = policyRegex.test(lower);
    const fallback = {
        normalized_query: raw,
        clarification_needed: false,
        requires_policy: fallbackRequiresPolicy,
        raw
    };
    if (!raw || !OPENAI_API_KEY) return fallback;
    try {
        const messages = [
            {
                role: 'system',
                content: `Convert the user question into a short policy or support search query for ${BRAND_NAME}. Reply ONLY JSON: {"normalized_query": string, "clarification_needed": boolean, "requires_policy": boolean}. Do not answer the question.`
            },
            { role: 'user', content: raw.slice(0, 360) }
        ];
        const completion = await openai.chat.completions.create({
            model: GPT_MODEL,
            messages,
            max_completion_tokens: 2000,
            temperature: 0
        });
        logTokenUsage("kb_normalize_query", { model: GPT_MODEL }, completion, messages);
        const choice = completion && completion.choices && completion.choices[0] ? completion.choices[0] : {};
        const msg = choice.message && typeof choice.message.content === 'string' ? choice.message.content.trim() : '';
        let parsed = null;
        try {
            parsed = JSON.parse(msg);
        } catch (e) {
            parsed = null;
        }
        if (!parsed || typeof parsed !== 'object') return fallback;
        const normalized = typeof parsed.normalized_query === 'string' && parsed.normalized_query.trim()
            ? parsed.normalized_query.trim()
            : raw;
        const clarification_needed = !!parsed.clarification_needed;
        const requires_policy = typeof parsed.requires_policy === 'boolean' ? parsed.requires_policy : fallbackRequiresPolicy;
        return {
            normalized_query: normalized,
            clarification_needed,
            requires_policy,
            raw
        };
    } catch (e) {
        console.error("Error in normalizeKbQuery:", e && e.message ? e.message : e);
        return fallback;
    }
}

async function searchWebsiteKnowledgeVector(queryText, options = {}) {
    const text = String(queryText || '').trim();
    if (!text) {
        return { matches: [], topScore: 0 };
    }
    try {
        const maxMatches = Number.isFinite(options.matchCount) && options.matchCount > 0 ? Math.floor(options.matchCount) : 8;
        const kbResult = await queryKnowledgeChunks(text, {
            matchCount: maxMatches,
            matchThreshold: KB_VECTOR_MATCH_THRESHOLD,
            maxChars: 520
        });
        let matches = Array.isArray(kbResult.matches)
            ? kbResult.matches
                  .map((m) => ({
                      content: String(m && m.content ? m.content : '').trim(),
                      score: typeof m.score === 'number' ? m.score : 0
                  }))
                  .filter((m) => m.content)
            : [];
        if (kbResult && kbResult.tableMissing) {
            const live = await queryKnowledgeBaseLive(text, { maxMatches, maxChars: 520, clip: true });
            if (live && Array.isArray(live.matches) && live.matches.length) {
                matches = live.matches.map((m) => ({
                    content: String(m || '').trim(),
                    score: typeof live.score === 'number' ? live.score : 0.5
                })).filter((m) => m.content);
            }
        }
        const topScore = matches.length ? matches[0].score : 0;
        return { matches, topScore };
    } catch (e) {
        console.error("Error in searchWebsiteKnowledgeVector:", e && e.message ? e.message : e);
        return { matches: [], topScore: 0 };
    }
}

async function generateAnswerFromKb(userQuery, normalizedQuery, kbMatches, options = {}) {
    if (!OPENAI_API_KEY) return '';
    const matches = Array.isArray(kbMatches) ? kbMatches : [];
    if (!matches.length) return '';
    const requiresPolicy = options && options.requiresPolicy;
    const maxMatches = 3;
    const selected = matches.slice(0, maxMatches);
    const contextParts = selected.map((m, index) => {
        const base = String(m && m.content ? m.content : '');
        const clipped = base.replace(/\s+/g, ' ').trim().slice(0, 320);
        return `(${index + 1}) ${clipped}`;
    });
    const kbContext = contextParts.join('\n\n');
    const userSnippet = String(userQuery || '').slice(0, 200);
    const normalizedText = String(normalizedQuery || userQuery || '').toLowerCase();
    const joinedContext = selected.map((m) => String(m && m.content ? m.content : '')).join('\n\n');
    if (requiresPolicy && /\bprivacy\b/.test(normalizedText)) {
        const updatedMatch = joinedContext.match(/last updated:\s*([a-z]+\s+\d{1,2},\s+\d{4})/i);
        const updatedText = updatedMatch ? ` Last updated: ${updatedMatch[1]}.` : '';
        return limitWordsForChat(
            `${BRAND_NAME}'s Privacy Policy explains how it collects, uses, and discloses personal information when you visit, use its services, or make a purchase.${updatedText}`,
            50
        );
    }
    const messages = [];
    if (requiresPolicy) {
        const template = botPrompts && typeof botPrompts.kbPolicyAssistantSystemPrompt === 'string'
            ? botPrompts.kbPolicyAssistantSystemPrompt
            : `You are a ${BRAND_NAME} policy assistant. Answer using ONLY the provided knowledge base excerpts. If excerpts don't contain the answer, say you don't know and suggest contacting ${BRAND_NAME} customer support.`;
        messages.push({
            role: 'system',
            content: String(template)
                .replace(/\{BRAND_NAME\}/g, BRAND_NAME)
                .replace(/\{CHATBOT_NAME\}/g, companyConfig.chatbot_name || BRAND_NAME)
                .replace(/\{SUPPORT_EMAIL\}/g, SUPPORT_EMAIL || '')
        });
    } else {
        const template = botPrompts && typeof botPrompts.kbSupportAssistantSystemPrompt === 'string'
            ? botPrompts.kbSupportAssistantSystemPrompt
            : `You are a ${BRAND_NAME} support assistant. Answer using ONLY the provided knowledge base excerpts. If the excerpts do not contain the required information, reply that you do not know and suggest contacting ${BRAND_NAME} customer support.`;
        messages.push({
            role: 'system',
            content: String(template)
                .replace(/\{BRAND_NAME\}/g, BRAND_NAME)
                .replace(/\{CHATBOT_NAME\}/g, companyConfig.chatbot_name || BRAND_NAME)
                .replace(/\{SUPPORT_EMAIL\}/g, SUPPORT_EMAIL || '')
        });
    }
    messages.push(
        {
            role: 'system',
            content: `Match the language and style of this user message (Hindi, English, or Hinglish mix): "${userSnippet}"`
        },
        {
            role: 'system',
            content: `Knowledge base excerpts:\n${kbContext}`
        },
        {
            role: 'user',
            content: `User question (normalized): "${String(normalizedQuery || '').trim() || String(userQuery || '').trim()}"`
        }
    );
    try {
        const completion = await openai.chat.completions.create({
            model: GPT_MODEL,
            messages,
            max_completion_tokens: 2000,
            temperature: 0.1
        });
        logTokenUsage("kb_generate_answer", { model: GPT_MODEL }, completion, messages);
        const choice = completion && completion.choices && completion.choices[0] ? completion.choices[0] : {};
        const msg = choice.message && typeof choice.message.content === 'string' ? choice.message.content.trim() : '';
        return msg;
    } catch (e) {
        console.error("Error in generateAnswerFromKb:", e && e.message ? e.message : e);
        return '';
    }
}

async function retrieve_knowledge({ query, max_snippets, max_chars }, socket) {
    const q = String(query || '').trim();
    if (!q) {
        return JSON.stringify({ success: false, error: "missing_query" });
    }
    const maxSnippets = Number.isFinite(max_snippets) ? Math.min(8, Math.max(1, Math.floor(max_snippets))) : 6;
    const maxChars = Number.isFinite(max_chars) ? Math.min(800, Math.max(120, Math.floor(max_chars))) : 520;
    try {
        const kbResult = await queryKnowledgeChunks(q, {
            matchCount: maxSnippets,
            matchThreshold: KB_VECTOR_MATCH_THRESHOLD,
            maxChars
        });
        const rawMatches = Array.isArray(kbResult && kbResult.matches) ? kbResult.matches : [];
        let snippets = rawMatches
            .map((m) => String(m && m.content ? m.content : '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .slice(0, maxSnippets);
            
        if (snippets.length === 0 || (kbResult && kbResult.tableMissing)) {
            const live = await queryKnowledgeBaseLive(q, { maxMatches: maxSnippets, maxChars, clip: true });
            if (live && Array.isArray(live.matches) && live.matches.length) {
                snippets = live.matches.map((m) => String(m || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, maxSnippets);
            }
        }
        const st = getUserState(socket.user_id);
        st.lastKnowledgeSnippets = snippets.slice(0, 4);
        st.lastKnowledgeQuery = q;
        st.lastKnowledgeAt = new Date().toISOString();
        setUserState(socket.user_id, st);
        return JSON.stringify({ success: true, query: q, snippets });
    } catch (e) {
        return JSON.stringify({ success: false, error: e && e.message ? String(e.message) : "knowledge_retrieval_failed" });
    }
}

async function answer_general_question({ userQuery }, socket) {
    const state = getUserState(socket.user_id);
    const q = String(userQuery || '').trim();
    const hasCouponWord = /(coupon|promo\s*code|promocode|discount\s*code|voucher|offer\s*code|apply\s+code|use\s+code|coupon\s+lagao|coupon\s+lagau|coupon\s+lagaun|code\s+lagao|code\s+lagau|code\s+lagaun)/i.test(q);
    const hasCalcIntent = /\b(final|after|net|total|pay|kitna|calculate|bachega|bachao|discount|off|kam)\b/i.test(q);
    const hasPctOrCode = (/\b\d{1,2}\s*%\b/.test(q) || /\b[A-Z]{3,15}\d{1,2}\b/i.test(q));
    const hasAmount = /\b\d{1,3}(?:,\d{3})+\b|\b\d{3,6}\b/.test(q);
    const isCouponMathQuery = hasCouponWord && hasCalcIntent && hasPctOrCode && hasAmount;
    if (isCouponMathQuery) {
        const langCode = state && typeof state.languageCode === 'string' ? state.languageCode : 'auto';
        const percentMatch = q.match(/\b(\d{1,2})\s*%\b/);
        let pct = percentMatch ? parseInt(percentMatch[1], 10) : null;
        if (!(pct && pct > 0 && pct < 100)) {
            const codePct = q.match(/\b[A-Z]{3,15}(\d{1,2})\b/i);
            pct = codePct ? parseInt(codePct[1], 10) : null;
        }
        const couponDigits = (() => {
            const m = q.match(/\b[A-Z]{3,15}(\d{1,2})\b/i);
            return m ? String(m[1]) : null;
        })();
        const rupeeTagged = q.match(/(?:₹|rs\.?\s*|inr\s*)(\d{1,3}(?:,\d{3})+|\d{3,6})\b/i);
        let amount = rupeeTagged ? parseInt(String(rupeeTagged[1]).replace(/,/g, ''), 10) : null;
        if (!(amount && Number.isFinite(amount) && amount >= 100)) {
            const tokens = q.match(/\b\d{1,3}(?:,\d{3})+\b|\b\d{3,6}\b/g) || [];
            const amounts = tokens
                .map((t) => parseInt(String(t).replace(/,/g, ''), 10))
                .filter((n) => Number.isFinite(n) && n >= 100 && String(n) !== String(couponDigits || ''));
            amount = amounts.length ? Math.max(...amounts) : null;
        }
        if (amount && pct && pct > 0 && pct < 100) {
            const discount = Math.round((amount * pct) / 100);
            const final = Math.max(0, amount - discount);
            const out = langCode === 'en'
                ? `If you apply a ${pct}% coupon on ₹${amount}, the discount is ₹${discount} and the final price is ₹${final}. Note: actual coupon terms like minimum cart value or maximum discount cap may apply.`
                : `Agar ₹${amount} ke cart par ${pct}% coupon apply hota hai, to discount ₹${discount} hoga aur final price ₹${final} hoga. Note: actual coupon terms (min cart / max cap) depend kar sakte hain.`;
            await sendMessage(socket, out, socket.user_id);
            return JSON.stringify({ success: true, answer: out });
        }
        const out2 = langCode === 'en'
            ? "I can calculate this, but I need the coupon percent (e.g., 10%/20%) and cart total amount."
            : "Main calculate kar sakta hoon, bas coupon ka % (jaise 10%/20%) aur cart total amount confirm kar do.";
        await sendMessage(socket, out2, socket.user_id);
        return JSON.stringify({ success: true, answer: out2 });
    }
    let answer = "I don’t have verified information on this yet. Please contact customer support for accurate details.";
    const wantsContactInfo = /\b(whatsapp|wa\s*number|contact\s*(number|no)|customer\s*care\s*(number|no)|support\s*(number|no)|phone\s*(number|no)|helpline|help\s*line)\b/i.test(String(q || "").toLowerCase());
    let contactText = "";
    try {
        const normalized = await normalizeKbQuery(userQuery);
        const normalizedQuery = normalized && typeof normalized.normalized_query === 'string' && normalized.normalized_query.trim()
            ? normalized.normalized_query.trim()
            : q;
        const requiresPolicy = normalized && typeof normalized.requires_policy === 'boolean'
            ? normalized.requires_policy
            : /(return|refund|exchange|replacement|replace|shipping|delivery|dispatch|courier|shipment|tracking|track|policy|warranty|payment|cod|cancel|order|support|contact|wapas|wapis|wapasi|vapas|vaapas|रिटर्न|रिफंड|एक्सचेंज|पालिसी|पॉलिसी|नीति|शिपिंग|डिलीवरी|ट्रैकिंग|वारंटी|भुगतान|कैंसिल|कैंसल)/i.test(String(q || "").toLowerCase());
        const pricingIntent = /\b(pricing|price|plan|plans|cost|charges|monthly|month|yearly|year)\b/i.test(String(q || '').toLowerCase());
        const knowledgeFirstIntent = /\b(privacy|data\s*privacy|personal\s*information|personal\s*data|return|refund|exchange|shipping|delivery|dispatch|courier|shipment|tracking|track|terms|contact|support|customer\s*care|about|company|brand|services|pricing|price|plan|plans|cost|charges|order\s*tracking)\b/i.test(String(q || '').toLowerCase());
        let answeredFromLivePricing = false;
        if (pricingIntent) {
            const live = await queryKnowledgeBaseLive(normalizedQuery || q, { matchCount: 8 });
            const liveMatches = Array.isArray(live.matches)
                ? live.matches.map((m) => ({ content: String(m || '').trim(), score: 1 }))
                : [];
            if (liveMatches.length) {
                const generated = await generateAnswerFromKb(userQuery, normalizedQuery || q, liveMatches, { requiresPolicy: false });
                const plain = liveMatches
                    .slice(0, 3)
                    .map((m) => String(m && m.content ? m.content : '').trim())
                    .filter(Boolean)
                    .join('\n\n');
                answer = (generated && generated.trim()) ? generated.trim() : plain;
                const meta = {
                    last_answer: answer.length > 160 ? `${answer.slice(0, 157)}...` : answer,
                    answer_source: "knowledge_base",
                    kb_source: `${BRAND_NAME} pricing page (live)`,
                    confidence: 0.9
                };
                const stMeta = getUserState(socket.user_id);
                stMeta.lastAnswerMeta = meta;
                setUserState(socket.user_id, stMeta);
                answeredFromLivePricing = true;
            }
        }
        if (!answeredFromLivePricing && (requiresPolicy || knowledgeFirstIntent)) {
            const live = await queryKnowledgeBaseLive(normalizedQuery || q, { matchCount: 8, maxChars: 520, clip: true });
            const liveMatches = Array.isArray(live && live.matches)
                ? live.matches
                    .map((m) => {
                        if (typeof m === 'string') return { content: String(m).trim(), score: 1 };
                        return { content: String(m && m.content ? m.content : '').trim(), score: typeof m && typeof m.score === 'number' ? m.score : 1 };
                    })
                    .filter((m) => m.content)
                : [];
            if (liveMatches.length) {
                const generated = await generateAnswerFromKb(userQuery, normalizedQuery || q, liveMatches, { requiresPolicy });
                const plain = liveMatches
                    .slice(0, 2)
                    .map((m) => String(m && m.content ? m.content : '').trim())
                    .filter(Boolean)
                    .join('\n\n');
                answer = (generated && generated.trim()) ? generated.trim() : plain;
                const meta = {
                    last_answer: answer.length > 160 ? `${answer.slice(0, 157)}...` : answer,
                    answer_source: "knowledge_base",
                    kb_source: `${BRAND_NAME} website pages (live scrape)`,
                    confidence: 0.95
                };
                const stMeta = getUserState(socket.user_id);
                stMeta.lastAnswerMeta = meta;
                setUserState(socket.user_id, stMeta);
                answeredFromLivePricing = true;
            }
        }
        const searchResult = answeredFromLivePricing
            ? { matches: [], topScore: 0 }
            : await searchWebsiteKnowledgeVector(normalizedQuery || q, { matchCount: 8 });
        const matches = Array.isArray(searchResult.matches) ? searchResult.matches : [];
        const topScore = typeof searchResult.topScore === 'number' ? searchResult.topScore : 0;
        const hasAnyKb = matches.length > 0;
        const hasStrongKb = hasAnyKb && (requiresPolicy ? true : topScore >= KB_VECTOR_MATCH_THRESHOLD);
        if (!answeredFromLivePricing && !hasStrongKb) {
            if (requiresPolicy) {
                answer = "I don’t have confirmed return policy information right now. Let me verify this for you.";
            } else if (normalized && normalized.clarification_needed) {
                answer = "Mujhe aapka question thoda unclear laga. Kya aap thoda aur detail mein bata sakte ho (jaise order ID, kaunsa product, kis type ki problem)?";
            } else {
                answer = `Mere paas is question ke liye abhi verified policy information nahi hai. Please ${BRAND_NAME} customer support se contact karke exact details confirm kar lo.`;
            }
            const meta = {
                last_answer: answer.length > 160 ? `${answer.slice(0, 157)}...` : answer,
                answer_source: "none",
                kb_source: "",
                confidence: 0
            };
            const stMeta = getUserState(socket.user_id);
            stMeta.lastAnswerMeta = meta;
            setUserState(socket.user_id, stMeta);
        } else if (!answeredFromLivePricing) {
            const generated = await generateAnswerFromKb(userQuery, normalizedQuery || q, matches, { requiresPolicy });
            if (generated && generated.trim()) {
                answer = generated.trim();
            } else {
                const plain = matches
                    .slice(0, 3)
                    .map((m) => String(m && m.content ? m.content : '').trim())
                    .filter(Boolean)
                    .join('\n\n');
                answer = plain || `Mere paas is question ke liye abhi verified policy information nahi hai. Please ${BRAND_NAME} customer support se contact karke exact details confirm kar lo.`;
            }
            const meta = {
                last_answer: answer.length > 160 ? `${answer.slice(0, 157)}...` : answer,
                answer_source: "knowledge_base",
                kb_source: `${BRAND_NAME} website_knowledge (vector search)`,
                confidence: Math.max(0, Math.min(1, hasAnyKb ? (topScore || (requiresPolicy ? 0.8 : 0.5)) : 0))
            };
            const stMeta = getUserState(socket.user_id);
            stMeta.lastAnswerMeta = meta;
            setUserState(socket.user_id, stMeta);
        }
        if (wantsContactInfo) {
            const info = await fetchContactInfoFromWebsite();
            if (info && info.displayText) {
                contactText = `${BRAND_NAME} support details:\n${info.displayText}`;
            }
        }
    } catch (e) {
        console.error("❌ Error in answer_general_question:", e && e.message ? e.message : e);
        answer = "Mere paas is question ke liye abhi verified information nahi hai. Please customer support se contact karke confirm kar lo.";
    }
    answer = limitWordsForChat(answer, 60) || limitWordsForChat("I don’t have verified information on this yet. Please contact customer support for accurate details.", 60);
    const stFinal = getUserState(socket.user_id);
    if (!stFinal.lastAnswerMeta) {
        const meta = {
            last_answer: answer.length > 160 ? `${answer.slice(0, 157)}...` : answer,
            answer_source: "none",
            kb_source: "",
            confidence: 0
        };
        stFinal.lastAnswerMeta = meta;
        setUserState(socket.user_id, stFinal);
    }
    await sendMessage(socket, answer, socket.user_id);
    if (contactText) {
        await sendMessage(socket, contactText, socket.user_id);
    }
    return JSON.stringify({ success: true, answer, contactText });
}

async function get_contact_info({ userQuery }, socket) {
    const q = String(userQuery || "").trim();
    let answerText = "";
    try {
        const info = await fetchContactInfoFromWebsite();
        if (info && info.displayText) {
            answerText = `${BRAND_NAME} support details:\n${info.displayText}`;
        } else {
            answerText = `Mere paas abhi verified ${BRAND_NAME} contact number nahi hai. Aap ${BRAND_WEBSITE}${WEBSITE_PATHS.contact || '/pages/contact'} page par latest details dekh sakte ho.`;
        }
    } catch (e) {
        console.error("❌ Error in get_contact_info:", e.message);
        answerText = `Mere paas abhi verified ${BRAND_NAME} contact number nahi hai. Aap ${BRAND_WEBSITE}${WEBSITE_PATHS.contact || '/pages/contact'} page par latest details dekh sakte ho.`;
    }
    const stMeta = getUserState(socket.user_id);
    const meta = {
        last_answer: answerText.length > 160 ? `${answerText.slice(0, 157)}...` : answerText,
        answer_source: "knowledge_base",
        kb_source: `${BRAND_NAME} contact page (scraped)`,
        confidence: 1
    };
    stMeta.lastAnswerMeta = meta;
    setUserState(socket.user_id, stMeta);
    await sendMessage(socket, answerText, socket.user_id);
    return JSON.stringify({ success: true, answerText });
}

async function get_privacy_policy_info({ userQuery }, socket) {
    return answer_general_question({ userQuery }, socket);
}

async function get_links({ userQuery, selectionText, selectionIndex, productId }, socket) {
    const state = getUserState(socket.user_id) || {};
    const qRaw = String(userQuery || '').trim();
    const q = qRaw || String(selectionText || '').trim();
    const lc = q.toLowerCase();

    const products = Array.isArray(state.lastDisplayedProducts) ? state.lastDisplayedProducts : [];
    const lastDetailed = state.lastDetailedProduct && typeof state.lastDetailedProduct === 'object' ? state.lastDetailedProduct : null;

    const wantProduct = /\b(product|shoe|sand(al)?|heel|flat|sneaker|boot|buy|buying|purchase|order|cart|checkout)\b/i.test(lc);
    const wantLink = /\b(link|url|website|page)\b/i.test(lc) || wantProduct;

    const resolveFromDisplayed = () => {
        if (!products.length) return null;
        const hasSelectionIndex = selectionIndex != null && Number.isFinite(Number(selectionIndex));
        if (hasSelectionIndex) {
            const idx = Math.trunc(Number(selectionIndex));
            if (idx >= 0 && idx < products.length) return products[idx];
        }
        const pid = productId != null ? String(productId).trim() : '';
        if (pid) {
            for (const p of products) {
                if (p && String(p.id || '') === pid) return p;
            }
        }
        const ordMap = {
            first: 0,
            '1st': 0,
            pehla: 0,
            pahla: 0,
            pehle: 0,
            pahle: 0,
            phle: 0,
            second: 1,
            '2nd': 1,
            dusra: 1,
            doosra: 1,
            dusre: 1,
            third: 2,
            '3rd': 2,
            teesra: 2,
            tisra: 2
        };
        const ord = lc.match(/\b(first|1st|second|2nd|third|3rd|pehla|pahla|pehle|pahle|phle|dusra|doosra|dusre|teesra|tisra)\b/);
        if (ord) {
            const idx = ordMap[ord[1]];
            if (Number.isFinite(idx) && products[idx]) return products[idx];
        }
        const codeMatch = lc.match(/\b(\d{3,6})\b/);
        if (codeMatch) {
            const code = codeMatch[1];
            for (const p of products) {
                if (!p) continue;
                const codes = Array.isArray(p.codes) ? p.codes.map(x => String(x)) : [];
                const skus = Array.isArray(p.skus) ? p.skus.map(x => String(x)) : [];
                const tags = Array.isArray(p.tags) ? p.tags.map(x => String(x)) : [];
                const name = p.name != null ? String(p.name) : '';
                if (codes.includes(code)) return p;
                if (skus.some(s => s.includes(code))) return p;
                if (tags.some(t => t.includes(code))) return p;
                if (name.includes(code)) return p;
            }
        }
        return null;
    };

    let product = null;
    if (wantLink) {
        product = resolveFromDisplayed();
        if (!product && lastDetailed) {
            const looksLikeProductRef = /\b(this|that|yeh|ye|wo|woh|wahi|same|iska|uska|is\s+ka|us\s+ka|wali|wala)\b/i.test(lc);
            if (looksLikeProductRef) product = lastDetailed;
        }
    }

    const cleanUrl = (u) => {
        const s = String(u || '').trim();
        if (!s) return '';
        if (/^https?:\/\//i.test(s)) return s;
        if (s.startsWith('/')) return `${BRAND_WEBSITE}${s}`;
        return '';
    };

    if (product) {
        const productUrl = cleanUrl(product.link);
        const cartUrl = `${BRAND_WEBSITE}${WEBSITE_PATHS.cart || '/cart'}`;
        const checkoutUrl = `${BRAND_WEBSITE}${WEBSITE_PATHS.checkout || '/checkout'}`;
        const lines = [];
        if (productUrl) lines.push(`- Product page: ${productUrl}`);
        lines.push(`- Cart: ${cartUrl}`);
        lines.push(`- Checkout: ${checkoutUrl}`);
        const out = lines.join('\n');
        await sendMessage(socket, out, socket.user_id);
        return JSON.stringify({ success: true, type: 'product', links: [productUrl, cartUrl, checkoutUrl].filter(Boolean), answerText: out });
    }

    const pageLinks = [];
    const add = (url) => {
        const u = cleanUrl(url);
        if (u && !pageLinks.includes(u)) pageLinks.push(u);
    };

    const hasAny = (re) => re.test(lc);
    if (hasAny(/\b(return|refund|exchange|replace|replacement)\b/)) add(`${BRAND_WEBSITE}${WEBSITE_PATHS.refundPolicy || '/policies/refund-policy'}`);
    if (hasAny(/\b(shipping|delivery|dispatch|courier|shipment|tracking|track)\b/)) add(`${BRAND_WEBSITE}${WEBSITE_PATHS.shippingPolicy || '/pages/shipping-policy'}`);
    if (hasAny(/\b(terms|conditions)\b/)) add(`${BRAND_WEBSITE}${WEBSITE_PATHS.terms || '/policies/terms-of-service'}`);
    if (hasAny(/\b(privacy|data\s*privacy|personal\s*data|personal\s*information)\b/)) add(`${BRAND_WEBSITE}${WEBSITE_PATHS.privacyPolicy || '/policies/privacy-policy'}`);
    if (hasAny(/\b(about|company|mission|vision|team|who\s+are)\b/)) add(`${BRAND_WEBSITE}${WEBSITE_PATHS.about || '/about-us/'}`);
    if (hasAny(/\b(service|services|feature|features|benefit|benefits|integration|integrations|multilingual|language|languages|whatsapp|instagram|facebook|crm)\b/)) {
        add(`${BRAND_WEBSITE}${WEBSITE_PATHS.services || '/our-services/'}`);
    }
    if (hasAny(/\b(pricing|price|plan|plans|cost|charges)\b/)) add(`${BRAND_WEBSITE}${WEBSITE_PATHS.pricing || '/pricing/'}`);
    if (hasAny(/\b(contact|support|customer\s*care|whatsapp|phone|email)\b/)) add(`${BRAND_WEBSITE}${WEBSITE_PATHS.contact || '/contact-us/'}`);

    if (hasAny(/\b(cart)\b/)) add(`${BRAND_WEBSITE}${WEBSITE_PATHS.cart || '/cart'}`);
    if (hasAny(/\b(checkout)\b/)) add(`${BRAND_WEBSITE}${WEBSITE_PATHS.checkout || '/checkout'}`);

    if (!pageLinks.length && wantLink) add(`${BRAND_WEBSITE}/`);

    if (!pageLinks.length) {
        const fallback = "Mujhe clear nahi hua kaunsa link chahiye. Aap 'about', 'services', 'pricing', 'contact', ya specific policy ka naam batao.";
        await sendMessage(socket, fallback, socket.user_id);
        return JSON.stringify({ success: false, type: 'unknown', links: [], answerText: fallback });
    }

    const out = pageLinks.slice(0, 5).map(u => `- ${u}`).join('\n');
    await sendMessage(socket, out, socket.user_id);
    return JSON.stringify({ success: true, type: 'page', links: pageLinks.slice(0, 5), answerText: out });
}

async function semantic_recommendation({ baseProductId, baseDescription, limit = 5 }, socket) {
    return semanticRecommendation({
        baseProductId,
        baseDescription,
        limit,
        socket,
        getLiveProducts,
        getUserState,
        userStates,
        vectorSearch,
        show_more_products,
        getRecommendedProductsForProduct
    });
}

async function upsell_recommendation({ baseProductId, limit = 5 }, socket) {
    return upsellRecommendation({
        baseProductId,
        limit,
        socket,
        getLiveProducts,
        getUserState,
        userStates,
        sendMessage,
        ranker,
        show_more_products,
        getRecommendedProductsForProduct
    });
}

async function cross_sell_recommendation({ baseProductId, limit = 5 }, socket) {
    return crossSellRecommendation({
        baseProductId,
        limit,
        socket,
        getLiveProducts,
        getUserState,
        userStates,
        sendMessage,
        ranker,
        show_more_products,
        getRecommendedProductsForProduct
    });
}

async function show_products(args, socket) {
    if (!toolsConfig || toolsConfig.product_recommendation === false) {
        try {
            const msg = `${BRAND_NAME} bot me product browsing enabled nahi hai. Aap services, features, pricing, ya support ke baare me puch sakte ho.`;
            await sendMessage(socket, msg, socket.user_id);
        } catch (e) {}
        return JSON.stringify({ success: false, summary: `Product browsing disabled for ${BRAND_NAME} context.`, totalMatches: 0 });
    }
    const a = args && typeof args === "object" ? args : {};
    const scopeRaw = typeof a.search_scope === "string" ? a.search_scope : null;
    let searchScope = scopeRaw ? scopeRaw.toLowerCase() : null;
    const queryTypeRaw = typeof a.query_type === "string" ? a.query_type : null;
    let queryType = queryTypeRaw ? queryTypeRaw.toLowerCase() : null;
    const searchText = a.search_text != null ? String(a.search_text) : "";

    const allowedQueryTypes = new Set(["search", "similar", "upsell", "cross_sell"]);
    const allowedScopes = new Set(["new", "refine", "continue"]);

    if (!searchScope || !allowedScopes.has(searchScope)) {
        searchScope = "new";
    }

    if (searchScope === "continue") {
        const st = getUserState(socket.user_id) || {};
        if (st.lastDisplayedCardsType === 'pricing') {
            const sent = await sendPricingCards(socket, socket.user_id, searchText || "");
            return JSON.stringify({ success: !!sent, summary: sent ? "Displayed more pricing plans." : "No more pricing plans.", totalMatches: sent ? 1 : 0 });
        }
        if (st.lastDisplayedCardsType === 'service') {
            const sent = await sendServiceCards(socket, socket.user_id, searchText || "");
            return JSON.stringify({ success: !!sent, summary: sent ? "Displayed more service cards." : "No more service cards.", totalMatches: sent ? 1 : 0 });
        }
        const sent = await sendServiceCards(socket, socket.user_id, searchText || "");
        return JSON.stringify({ success: !!sent, summary: sent ? "Displayed service cards." : "No cards available.", totalMatches: sent ? 1 : 0 });
    }

    if (!queryType || !allowedQueryTypes.has(queryType)) {
        queryType = "search";
    }

    const st = getUserState(socket.user_id) || {};
    const wantsPricing = shouldShowPricingCards(searchText) || queryType === "upsell" || queryType === "cross_sell";
    const wantsProducts = shouldShowProductCards(searchText);
    const wantsServices = shouldShowServiceCards(searchText) && !wantsProducts;

    let target = "service";
    if (wantsPricing) target = "pricing";
    else if (wantsProducts) target = "product";

    if (target === "product") {
        return await search_products({ userQuery: searchText }, socket);
    }

    if (target === "pricing") {
        st.lastPricingPlansIndex = 0;
        st.lastDisplayedCardsType = 'pricing';
        setUserState(socket.user_id, st);
    } else {
        st.lastServiceCardsIndex = 0;
        st.lastDisplayedCardsType = 'service';
        setUserState(socket.user_id, st);
    }
    const sent = target === "pricing"
        ? await sendPricingCards(socket, socket.user_id, searchText || "")
        : await sendServiceCards(socket, socket.user_id, searchText || "");
    
    if (!sent) {
        if (target === "pricing") {
            const fallbackSent = await sendServiceCards(socket, socket.user_id, searchText || "");
            if (fallbackSent) return JSON.stringify({ success: true, summary: "Displayed service cards as fallback.", totalMatches: 1 });
        }
        
        // Final fallback if nothing was sent
        const fallbackMsg = (botConfig.phrases.fallback_detailed || "I couldn't find specific {TARGET} details right now.")
            .replace('{TARGET}', target)
            .replace('{WEBSITE}', BRAND_WEBSITE);
        await sendMessage(socket, fallbackMsg, socket.user_id);
        return JSON.stringify({ success: false, summary: "No cards available, sent text fallback.", totalMatches: 0 });
    }
    
    return JSON.stringify({ success: true, summary: `Displayed ${target} cards.`, totalMatches: 1 });
}

async function attempt_to_solve_issue({ issueDescription }, socket) {
    return attemptToSolveIssue({ issueDescription, callOpenAI, queryKnowledgeBase: queryKnowledgeChunks });
}

async function raise_support_ticket({ name, email, issue }, socket) {
    const st = socket && socket.user_id ? (getUserState(socket.user_id) || {}) : {};
    const resolvedName = (name != null && String(name).trim()) ? String(name).trim() : (st.userName != null && String(st.userName).trim() ? String(st.userName).trim() : undefined);
    const resolvedEmail = (email != null && String(email).trim()) ? String(email).trim() : (st.email != null && String(st.email).trim() ? String(st.email).trim() : undefined);
    return raiseSupportTicket({ name: resolvedName, email: resolvedEmail, issue, socket, supabase, getBotId });
}

async function createSupportTicket({ user_id, message, channel }) {
    return createSupportTicketCore({ user_id, message, channel, supabase, getBotId });
}

async function admin_mode({ command, value }, socket) {
    if (command === 'check_password') {
        if (value === ADMIN_PASSWORD) {
            const dashboardOptions = {
                title: "Admin Command Center",
                options: [
                    { label: "Today's Tickets", command: "report_tickets_today" },
                    { label: "Today's Visitors", command: "report_visitors_today" }
                ]
            };
            return JSON.stringify({ success: true, type: 'admin_dashboard', data: dashboardOptions });
        } else {
            return JSON.stringify({ success: false, error: "Incorrect password." });
        }
    } else if (command === 'sleep' && getUserState(socket.user_id).mode === 'admin') {
        userStates.delete(socket.user_id);
        await sendMessage(socket, '__ADMIN_MODE_DEACTIVATED__', socket.user_id);
        return JSON.stringify({ success: true, message: "Admin mode deactivated." });
    } else if (command === 'get_report' && getUserState(socket.user_id).mode === 'admin') {
        try {
            let reportData = { title: "Report", content: "No data found." };
            const today = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });

            if (value === 'report_tickets_today') {
                const result = await getTicketsReportToday({ supabase, botId: getBotId && getBotId() });
                if (!result.success) {
                    return JSON.stringify({ success: false, error: result.error });
                }
                const ticketsToday = result.ticketsToday || 0;
                reportData = { title: "Today's Tickets", content: `${ticketsToday} support tickets have been raised today.` };
            } else if (value === 'report_visitors_today') {
                reportData = { title: "Today's Visitors", content: "Visitor tracking needs full implementation." };
            }
            return JSON.stringify({ success: true, type: 'admin_report', data: reportData });
        } catch (e) {
            console.error(`Report error for ${value}:`, e.message);
            return JSON.stringify({ success: false, error: `Failed to fetch report: ${e.message}` });
        }
    }
    return JSON.stringify({ success: false, error: "Invalid admin command or not in admin mode." });
}

async function describe_selected_product({ selectionText, selectionIndex, productId, userQuestion }, socket) {
    const st = getUserState(socket.user_id) || {};
    const query = String(userQuestion || selectionText || '').trim();
    
    // First, check if user is asking about a PRODUCT from the catalog
    let product = null;
    if (productId) {
        const allProducts = await getLiveProducts();
        product = allProducts.find(p => String(p.id) === String(productId));
    }

    const displayed = Array.isArray(st.lastDisplayedProducts) ? st.lastDisplayedProducts : [];
    if (!product && displayed.length) {
        if (productId) {
            product = displayed.find(p => p && String(p.id) === String(productId)) || null;
        }
        if (!product) {
            product = resolveCardFromSelection(displayed, selectionText, selectionIndex);
        }
    }
    
    if (!product && (st.lastSearchResults || st.lastQueryProducts)) {
        const pool = st.lastSearchResults || st.lastQueryProducts || [];
        product = resolveCardFromSelection(pool, selectionText, selectionIndex);
    }

    if (product) {
        const cur = getUserState(socket.user_id) || {};
        const viewed = Array.isArray(cur.viewedProducts) ? cur.viewedProducts.slice() : [];
        viewed.push(product);
        while (viewed.length > 20) viewed.shift();
        setUserState(socket.user_id, { ...cur, lastDetailedProduct: product, viewedProducts: viewed });

        // Reuse the normal product-card delivery flow for a single selected item.
        const normalizedProduct = {
            ...product,
            link: normalizeProductLinkForFrontend(product && product.link)
        };
        if (socket.isWhatsApp) {
            await sendWhatsAppProductMessage(socket.user_id, normalizedProduct);
        } else {
            await sendMessage(socket, {
                type: '__PRODUCT_CATALOG__',
                data: [normalizedProduct],
                meta: { mode: 'replace' }
            }, socket.user_id);
            await sendMessage(socket, { type: '__CONTROL_SHOW_MORE__', data: { show: false } }, socket.user_id);
        }
        
        // Build and send AI summary
        const name = product.name || product.title;
        const price = product.price ? `Price: ${product.price}.` : "";
        const desc = product.description ? String(product.description).replace(/\s+/g, ' ').trim() : "";
        const briefDesc = limitWordsForChat(desc, 24);
        const summary = limitWordsForChat(
            [name ? `${name}:` : "", briefDesc, price, normalizedProduct.link ? `Link: ${normalizedProduct.link}` : ""]
                .filter(Boolean)
                .join(' '),
            50
        );
        
        await sendMessage(socket, summary, socket.user_id);
        return JSON.stringify({ success: true, summary });
    }

    // Fallback to legacy service/pricing logic if not a product
    const wantsPricing = shouldShowPricingCards(query) || st.lastDisplayedCardsType === 'pricing';
    let cards = wantsPricing ? st.lastPricingPlans : st.lastServiceCards;
    if (!Array.isArray(cards) || !cards.length) {
        cards = wantsPricing ? await fetchPricingPlansFromWebsite(false) : await fetchServiceCardsFromWebsite(false);
        if (wantsPricing) {
            st.lastPricingPlans = cards;
            st.lastDisplayedCardsType = 'pricing';
        } else {
            st.lastServiceCards = cards;
            st.lastDisplayedCardsType = 'service';
        }
        setUserState(socket.user_id, st);
    }
    const card = resolveCardFromSelection(cards, selectionText, selectionIndex);
    if (!card) {
        const msg = "I couldn’t find that product or service. Please ask me to show products again.";
        await sendMessage(socket, msg, socket.user_id);
        return JSON.stringify({ success: false, error: "card_not_found", answerText: msg });
    }
    let out = "";
    if (wantsPricing) {
        const price = card.price ? `Price: ${card.price}. ` : "";
        const features = Array.isArray(card.features) ? card.features.slice(0, 6).join(', ') : "";
        const featuresText = features ? `Features: ${features}. ` : "";
        const link = card.link ? `Details: ${card.link}` : "";
        out = `${card.name}. ${price}${featuresText}${link}`.trim();
    } else {
        const desc = card.description ? `${card.description}. ` : "";
        const link = card.link ? `Details: ${card.link}` : "";
        out = `${card.name}. ${desc}${link}`.trim();
    }
    await sendMessage(socket, out, socket.user_id);
    return JSON.stringify({ success: true, answerText: out });
}

function extractCompareHints(text) {
    const raw = String(text || '');
    const codes = raw.match(/\b\d{3,6}\b/g) || [];
    const uniqueCodes = Array.from(new Set(codes.map(String)));
    const skuMatches = raw.match(/\b[A-Z]{1,6}[-\s]?\d{2,6}[A-Z0-9]*\b/ig) || [];
    const uniqueSkus = Array.from(new Set(skuMatches.map(s => String(s).trim())));
    if (uniqueCodes.length >= 2) {
        return [{ type: 'code', value: uniqueCodes[0] }, { type: 'code', value: uniqueCodes[1] }];
    }
    if (uniqueSkus.length >= 2) {
        return [{ type: 'sku', value: uniqueSkus[0] }, { type: 'sku', value: uniqueSkus[1] }];
    }
    if (uniqueCodes.length === 1 && uniqueSkus.length === 1) {
        return [{ type: 'code', value: uniqueCodes[0] }, { type: 'sku', value: uniqueSkus[0] }];
    }
    const betweenMatch = raw.match(/\bbetween\s+(.+?)\s+and\s+(.+?)(?:[?.!]|$)/i);
    if (betweenMatch) {
        const a = String(betweenMatch[1] || '').trim();
        const b = String(betweenMatch[2] || '').trim();
        if (a.length >= 3 && b.length >= 3) return [{ type: 'name', value: a }, { type: 'name', value: b }];
    }
    const vsMatch = raw.match(/\b(.+?)\s+(?:vs|v\/s|versus)\s+(.+?)(?:[?.!]|$)/i);
    if (vsMatch) {
        const a = String(vsMatch[1] || '').trim();
        const b = String(vsMatch[2] || '').trim();
        if (a.length >= 3 && b.length >= 3) return [{ type: 'name', value: a }, { type: 'name', value: b }];
    }
    return null;
}

function resolveProductFromHint(hint, products, excludeId) {
    if (!hint || !Array.isArray(products) || !products.length) return null;
    const exclude = excludeId != null ? String(excludeId) : null;
    const value = String(hint.value || '').trim();
    const valueLc = value.toLowerCase();
    if (!value) return null;

    const byPredicate = (pred) => {
        for (const p of products) {
            if (!p) continue;
            const id = p.id != null ? String(p.id) : null;
            if (exclude && id && id === exclude) continue;
            if (pred(p)) return p;
        }
        return null;
    };

    if (hint.type === 'code') {
        const code = value;
        const codeRe = new RegExp(`\\b${code}\\b`);
        const exactByCodes = products.filter(p => {
            if (!p) return false;
            const id = p.id != null ? String(p.id) : null;
            if (exclude && id && id === exclude) return false;
            const codes = Array.isArray(p.codes) ? p.codes.map(x => String(x)) : [];
            return codes.includes(code);
        });
        if (exactByCodes.length === 1) return exactByCodes[0];
        if (exactByCodes.length > 1) {
            const byNameBoundary = exactByCodes.find(p => codeRe.test(String(p && p.name ? p.name : "")));
            return byNameBoundary || exactByCodes[0];
        }
        const exactByName = products.filter(p => {
            if (!p) return false;
            const id = p.id != null ? String(p.id) : null;
            if (exclude && id && id === exclude) return false;
            const name = p.name != null ? String(p.name) : "";
            return codeRe.test(name);
        });
        if (exactByName.length === 1) return exactByName[0];
        const exactBySkuBoundary = products.filter(p => {
            if (!p) return false;
            const id = p.id != null ? String(p.id) : null;
            if (exclude && id && id === exclude) return false;
            const skus = Array.isArray(p.skus) ? p.skus.map(x => String(x)) : [];
            return skus.some(s => codeRe.test(s));
        });
        if (exactBySkuBoundary.length === 1) return exactBySkuBoundary[0];
        return null;
    }

    if (hint.type === 'sku') {
        const exactSku = byPredicate((p) => {
            const skus = Array.isArray(p.skus) ? p.skus.map(x => String(x).toLowerCase()) : [];
            return skus.some(s => s === valueLc);
        });
        if (exactSku) return exactSku;
        const partialSkuMatches = products.filter(p => {
            if (!p) return false;
            const id = p.id != null ? String(p.id) : null;
            if (exclude && id && id === exclude) return false;
            const skus = Array.isArray(p.skus) ? p.skus.map(x => String(x).toLowerCase()) : [];
            return skus.some(s => s.includes(valueLc));
        });
        if (partialSkuMatches.length === 1) return partialSkuMatches[0];
        return null;
    }

    if (hint.type === 'name') {
        const stop = new Set([
            'model', 'product', 'item', 'sku', 'code',
            'compare', 'comparison', 'vs', 'versus', 'between', 'and', 'aur',
            'which', 'better', 'best', 'kaunsa', 'konsa', 'kounsa', 'farak',
            'price', 'rs', 'rupees', 'mrp', 'discount', 'offer',
            'me', 'mein', 'mai', 'ka', 'ki', 'ke', 'hai', 'kya'
        ]);
        const tokens = valueLc
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length >= 3 && !stop.has(t));
        if (!tokens.length) return null;

        let best = null;
        let bestScore = 0;
        for (const p of products) {
            if (!p) continue;
            const id = p.id != null ? String(p.id) : null;
            if (exclude && id && id === exclude) continue;
            const nameLc = p.name != null ? String(p.name).toLowerCase() : "";
            const tagsLc = Array.isArray(p.tags) ? p.tags.map(t => String(t).toLowerCase()).join(' ') : "";
            const skusLc = Array.isArray(p.skus) ? p.skus.map(s => String(s).toLowerCase()).join(' ') : "";
            const codesLc = Array.isArray(p.codes) ? p.codes.map(s => String(s).toLowerCase()).join(' ') : "";
            let score = 0;
            for (const t of tokens) {
                if (nameLc.includes(t)) score += 6;
                if (tagsLc.includes(t)) score += 2;
                if (skusLc.includes(t)) score += 2;
                if (codesLc.includes(t)) score += 2;
            }
            if (score > bestScore) {
                bestScore = score;
                best = p;
            }
        }
        return bestScore >= 6 ? best : null;
    }

    return null;
}

async function compare_recent_products({ userQuestion }, socket) {
    const st = getUserState(socket.user_id) || {};
    const q = String(userQuestion || '').trim();
    const wantsPricing = shouldShowPricingCards(q) || st.lastDisplayedCardsType === 'pricing';
    let cards = wantsPricing ? st.lastPricingPlans : st.lastServiceCards;
    if (!Array.isArray(cards) || cards.length < 2) {
        cards = wantsPricing ? await fetchPricingPlansFromWebsite(false) : await fetchServiceCardsFromWebsite(false);
        if (wantsPricing) {
            st.lastPricingPlans = cards;
            st.lastDisplayedCardsType = 'pricing';
        } else {
            st.lastServiceCards = cards;
            st.lastDisplayedCardsType = 'service';
        }
        setUserState(socket.user_id, st);
    }
    if (!Array.isArray(cards) || cards.length < 2) {
        const msg = "I don’t have enough plans or services to compare right now. Please ask me to show them first.";
        await sendMessage(socket, msg, socket.user_id);
        return JSON.stringify({ success: false, error: "not_enough_cards", answerText: msg });
    }
    const names = extractCompareNames(q);
    let a = null;
    let b = null;
    if (names && names.length === 2) {
        a = findBestCardMatch(cards, names[0]);
        b = findBestCardMatch(cards, names[1]);
    }
    if (!a || !b || a === b) {
        a = cards[0];
        b = cards[1];
    }
    await sendMessage(socket, { type: wantsPricing ? '__PRICING_PLANS__' : '__SERVICE_CARDS__', data: [a, b] }, socket.user_id);
    const text = wantsPricing
        ? buildPricingComparisonText(a, b, q, false)
        : buildServiceComparisonText(a, b, false);
    await sendMessage(socket, text, socket.user_id);
    return JSON.stringify({ success: true, answerText: text });
}

async function smart_compare_products({ userQuestion }, socket) {
    const st = getUserState(socket.user_id) || {};
    const q = String(userQuestion || '').trim();
    const wantsPricing = shouldShowPricingCards(q) || st.lastDisplayedCardsType === 'pricing';
    let cards = wantsPricing ? st.lastPricingPlans : st.lastServiceCards;
    if (!Array.isArray(cards) || cards.length < 2) {
        cards = wantsPricing ? await fetchPricingPlansFromWebsite(false) : await fetchServiceCardsFromWebsite(false);
        if (wantsPricing) {
            st.lastPricingPlans = cards;
            st.lastDisplayedCardsType = 'pricing';
        } else {
            st.lastServiceCards = cards;
            st.lastDisplayedCardsType = 'service';
        }
        setUserState(socket.user_id, st);
    }
    if (!Array.isArray(cards) || cards.length < 2) {
        const msg = "I don’t have enough plans or services to compare right now. Please ask me to show them first.";
        await sendMessage(socket, msg, socket.user_id);
        return JSON.stringify({ success: false, error: "not_enough_cards", answerText: msg });
    }
    const names = extractCompareNames(q);
    let a = null;
    let b = null;
    if (names && names.length === 2) {
        a = findBestCardMatch(cards, names[0]);
        b = findBestCardMatch(cards, names[1]);
    }
    if (!a || !b || a === b) {
        a = cards[0];
        b = cards[1];
    }
    await sendMessage(socket, { type: wantsPricing ? '__PRICING_PLANS__' : '__SERVICE_CARDS__', data: [a, b] }, socket.user_id);
    const text = wantsPricing
        ? buildPricingComparisonText(a, b, q, true)
        : buildServiceComparisonText(a, b, true);
    await sendMessage(socket, text, socket.user_id);
    return JSON.stringify({ success: true, answerText: text });
}

async function fetchRecentAgentMessages(dbUserId, limit = 10) {
    if (!supabase || !dbUserId || !getBotId()) return [];
    
    try {
        // Try to fetch from human_handoff_chat_logs first
        const { data: handoffData, error: handoffError } = await supabase
            .from('human_handoff_chat_logs')
            .select('message, sender, timestamp')
            .eq('chat_user_id', dbUserId)
            .eq('sender', 'Agent')
            .order('timestamp', { ascending: false })
            .limit(limit);

        if (!handoffError && handoffData && handoffData.length > 0) {
            console.log("FETCHED_AGENT_MESSAGES_FROM_HANDOFF", { 
                dbUserId, 
                count: handoffData.length,
                latest: handoffData[0]?.timestamp 
            });
            return handoffData.reverse(); // Return in chronological order
        }

        // Fallback to chat_logs table
        const { data: chatData, error: chatError } = await supabase
            .from('chat_logs')
            .select('message, sender, timestamp, created_at')
            .eq('chat_user_id', dbUserId)
            .eq('sender', 'Agent')
            .order('timestamp', { ascending: false })
            .limit(limit);

        if (!chatError && chatData && chatData.length > 0) {
            console.log("FETCHED_AGENT_MESSAGES_FROM_CHAT_LOGS", { 
                dbUserId, 
                count: chatData.length,
                latest: chatData[0]?.timestamp || chatData[0]?.created_at
            });
            return chatData.reverse(); // Return in chronological order
        }

        console.log("NO_AGENT_MESSAGES_FOUND", { dbUserId });
        return [];
    } catch (error) {
        console.error("ERROR_FETCHING_AGENT_MESSAGES", { dbUserId, error: error.message });
        return [];
    }
}

async function sendAgentMessageToUser(userKey, text) {
    let target = liveUserSockets.get(userKey);
    if (!target) {
        const asNumber = Number(userKey);
        if (Number.isFinite(asNumber)) {
            for (const [, socket] of liveUserSockets.entries()) {
                if (socket && socket.__dbUserId === asNumber) {
                    target = socket;
                    break;
                }
            }
        }
    }
    if (!target || typeof target.emit !== 'function') {
        try {
            console.warn("AGENT_MESSAGE_NO_ACTIVE_SOCKET", { userKey });
        } catch (e) {}
        return false;
    }
    const sanitized = sanitizeMessage(text);
    const clipped = limitWordsForChat(sanitized);
    const outgoing = formatMessageForWeb(clipped);
    const platformUserId = target.__platformUserId || target.user_id || String(userKey);
    console.log("SENDING_AGENT_MESSAGE", { 
        userId: platformUserId, 
        dbUserId: target.__dbUserId,
        messageLength: outgoing.length 
    });
    target.emit('message', {
        type: 'message',
        data: outgoing,
        sender: 'agent-message'
    });
    if (supabase && target.__dbUserId && clipped && getBotId()) {
        const userId = target.__dbUserId;
        const source = target.__platform || (target.isWhatsApp ? 'WhatsApp' : 'Website');
        const st = getUserState(platformUserId);
        await insertChatLogRecord({ userId, platformUserId, source, sender: 'Agent', message: clipped, conversationId: st && st.conversationId ? st.conversationId : null });
    }
    return true;
}

io.on('connection', (socket) => {
    socket.on('init', async ({ user_id, page_context }) => {
        if (!user_id) return;
        socket.user_id = user_id;
        socket.isWhatsApp = false;
        liveUserSockets.set(user_id, socket);
        socket.__sendMessage = sendMessage;
        socket.__callOpenAI = (messages, useTools = false, toolsOverride) => safeCallOpenAI(user_id, messages, useTools, toolsOverride);
        socket.__getSystemPrompt = getSystemPrompt;
        socket.__getUserState = getUserState;
        socket.__setUserState = setUserState;
        socket.__pushConversation = pushConversation;
        socket.__tools = tools;
        const getAnalyticsUserIds = () => ({
            userId: socket.__dbUserId || null,
            platformUserId: socket.__platformUserId || socket.user_id || null
        });
        socket.__toolFns = {
            show_products: async (args, s) => {
                const ids = getAnalyticsUserIds();
                const st = getUserState(s.user_id);
                await logAnalyticsEvent({
                    userId: ids.userId,
                    platformUserId: ids.platformUserId,
                    eventType: 'recommendation_request',
                    payload: { tool: 'show_products', args },
                    pageContext: st && st.pageContext ? st.pageContext : null
                });
                return show_products(args, s);
            },
            answer_general_question: async (args, s) => {
                const ids = getAnalyticsUserIds();
                const st = getUserState(s.user_id);
                await logAnalyticsEvent({
                    userId: ids.userId,
                    platformUserId: ids.platformUserId,
                    eventType: 'faq',
                    payload: { tool: 'answer_general_question', args },
                    pageContext: st && st.pageContext ? st.pageContext : null
                });
                return answer_general_question(args, s);
            },
            get_contact_info,
            get_privacy_policy_info,
            get_links,
            attempt_to_solve_issue,
            raise_support_ticket,
            admin_mode,
            describe_selected_product,
            compare_recent_products: async (args, s) => {
                const ids = getAnalyticsUserIds();
                const st = getUserState(s.user_id);
                await logAnalyticsEvent({
                    userId: ids.userId,
                    platformUserId: ids.platformUserId,
                    eventType: 'comparison_request',
                    payload: { tool: 'compare_recent_products', args },
                    pageContext: st && st.pageContext ? st.pageContext : null
                });
                return compare_recent_products(args, s);
            },
            smart_compare_products: async (args, s) => {
                const ids = getAnalyticsUserIds();
                const st = getUserState(s.user_id);
                await logAnalyticsEvent({
                    userId: ids.userId,
                    platformUserId: ids.platformUserId,
                    eventType: 'comparison_request',
                    payload: { tool: 'smart_compare_products', args },
                    pageContext: st && st.pageContext ? st.pageContext : null
                });
                return smart_compare_products(args, s);
            }
        };
        if (page_context) {
            updateUserPageContext(user_id, page_context);
        }
        let dbUserId = null;
        const platformUserId = user_id;
        const platform = 'Website';
        if (supabase && getBotId()) {
            const user = await getOrCreateUserRecord(platform, platformUserId);
            if (user && user.id != null) {
                dbUserId = user.id;
            }
        }
        socket.__dbUserId = dbUserId;
        socket.__platform = platform;
        socket.__platformUserId = platformUserId;

        // Store last fetched timestamp for polling
        socket.__lastAgentMessageCheck = new Date().toISOString();

        // Set up polling for new agent messages (every 5 seconds)
        socket.__agentMessagePollInterval = setInterval(async () => {
            if (!socket.__dbUserId) return;
            
            try {
                const { data: newMessages, error } = await supabase
                    .from('human_handoff_chat_logs')
                    .select('message, sender, timestamp')
                    .eq('chat_user_id', socket.__dbUserId)
                    .eq('sender', 'Agent')
                    .gt('timestamp', socket.__lastAgentMessageCheck)
                    .order('timestamp', { ascending: true });

                if (!error && newMessages && newMessages.length > 0) {
                    console.log("POLLING_FOUND_NEW_AGENT_MESSAGES", { 
                        userId: user_id, 
                        dbUserId: socket.__dbUserId, 
                        count: newMessages.length 
                    });
                    
                    for (const agentMsg of newMessages) {
                        const messageText = agentMsg.message || '';
                        if (messageText.trim()) {
                            const sanitized = sanitizeMessage(messageText);
                            const clipped = limitWordsForChat(sanitized);
                            const outgoing = formatMessageForWeb(clipped);
                            
                            socket.emit('message', {
                                type: 'message',
                                data: outgoing,
                                sender: 'agent-message'
                            });
                            
                            console.log("POLLING_SENT_AGENT_MESSAGE", { 
                                userId: user_id, 
                                messageLength: outgoing.length,
                                timestamp: agentMsg.timestamp
                            });
                        }
                    }
                    
                    // Update last check timestamp
                    socket.__lastAgentMessageCheck = new Date().toISOString();
                }
            } catch (pollError) {
                console.error("POLLING_ERROR", { userId: user_id, error: pollError.message });
            }
        }, 5000);

        // Fetch and display recent agent messages from database
        if (dbUserId) {
            try {
                const recentAgentMessages = await fetchRecentAgentMessages(dbUserId, 5);
                if (recentAgentMessages && recentAgentMessages.length > 0) {
                    console.log("DISPLAYING_RECENT_AGENT_MESSAGES", { 
                        user_id, 
                        dbUserId, 
                        count: recentAgentMessages.length 
                    });
                    
                    // Send each agent message to the frontend
                    for (const agentMsg of recentAgentMessages) {
                        const messageText = agentMsg.message || '';
                        if (messageText.trim()) {
                            const sanitized = sanitizeMessage(messageText);
                            const clipped = limitWordsForChat(sanitized);
                            const outgoing = formatMessageForWeb(clipped);
                            
                            socket.emit('message', {
                                type: 'message',
                                data: outgoing,
                                sender: 'agent-message'
                            });
                            
                            console.log("SENT_RECENT_AGENT_MESSAGE", { 
                                user_id, 
                                messageLength: outgoing.length,
                                timestamp: agentMsg.timestamp || agentMsg.created_at
                            });
                        }
                    }
                }
            } catch (error) {
                console.error("ERROR_DISPLAYING_RECENT_AGENT_MESSAGES", { user_id, dbUserId, error: error.message });
            }
        }

        const st = getUserState(user_id);
        if (!st.userName && !st.nameDeclined && !st.namePrompted) {
            st.namePrompted = true;
            st.awaitingName = true;
            setUserState(user_id, st);
            const out = botConfig.phrases.ask_name;
            await sendMessage(socket, out, user_id);
            pushConversation(st, 'bot', out);
        } else if (st.userName && !st.email && !st.phone && !st.contactDeclined && !st.contactPrompted) {
            st.contactPrompted = true;
            st.awaitingContact = true;
            setUserState(user_id, st);
            const out = (botConfig.phrases.ask_contact || "Nice to meet you, {NAME}. Would you like to share your contact?")
                .replace('{NAME}', st.userName);
            await sendMessage(socket, out, user_id);
            pushConversation(st, 'bot', out);
        }
    });
    socket.on('message', async ({ message, user_id, page_context }) => {
        if (!user_id || !message) return;
        if (page_context) {
            updateUserPageContext(user_id, page_context);
        }
        socket.user_id = user_id;
        socket.isWhatsApp = false;
        liveUserSockets.set(user_id, socket);
        socket.__sendMessage = sendMessage;
        socket.__callOpenAI = (messages, useTools = false, toolsOverride) => safeCallOpenAI(user_id, messages, useTools, toolsOverride);
        socket.__getSystemPrompt = getSystemPrompt;
        socket.__getUserState = getUserState;
        socket.__setUserState = setUserState;
        socket.__pushConversation = pushConversation;
        socket.__tools = tools;
        const getAnalyticsUserIdsMsg = () => ({
            userId: socket.__dbUserId || null,
            platformUserId: socket.__platformUserId || socket.user_id || null
        });
        socket.__toolFns = {
            show_products: async (args, s) => {
                const ids = getAnalyticsUserIdsMsg();
                const st = getUserState(s.user_id);
                await logAnalyticsEvent({
                    userId: ids.userId,
                    platformUserId: ids.platformUserId,
                    eventType: 'recommendation_request',
                    payload: { tool: 'show_products', args },
                    pageContext: st && st.pageContext ? st.pageContext : null
                });
                return show_products(args, s);
            },
            answer_general_question: async (args, s) => {
                const ids = getAnalyticsUserIdsMsg();
                const st = getUserState(s.user_id);
                await logAnalyticsEvent({
                    userId: ids.userId,
                    platformUserId: ids.platformUserId,
                    eventType: 'faq',
                    payload: { tool: 'answer_general_question', args },
                    pageContext: st && st.pageContext ? st.pageContext : null
                });
                return answer_general_question(args, s);
            },
            retrieve_knowledge: async (args, s) => {
                const ids = getAnalyticsUserIdsMsg();
                const st = getUserState(s.user_id);
                await logAnalyticsEvent({
                    userId: ids.userId,
                    platformUserId: ids.platformUserId,
                    eventType: 'knowledge_lookup',
                    payload: { tool: 'retrieve_knowledge', args },
                    pageContext: st && st.pageContext ? st.pageContext : null
                });
                return retrieve_knowledge(args, s);
            },
            get_contact_info,
            get_privacy_policy_info,
            get_links,
            attempt_to_solve_issue,
            raise_support_ticket,
            admin_mode,
            describe_selected_product,
            compare_recent_products: async (args, s) => {
                const ids = getAnalyticsUserIdsMsg();
                const st = getUserState(s.user_id);
                await logAnalyticsEvent({
                    userId: ids.userId,
                    platformUserId: ids.platformUserId,
                    eventType: 'comparison_request',
                    payload: { tool: 'compare_recent_products', args },
                    pageContext: st && st.pageContext ? st.pageContext : null
                });
                return compare_recent_products(args, s);
            },
            smart_compare_products: async (args, s) => {
                const ids = getAnalyticsUserIdsMsg();
                const st = getUserState(s.user_id);
                await logAnalyticsEvent({
                    userId: ids.userId,
                    platformUserId: ids.platformUserId,
                    eventType: 'comparison_request',
                    payload: { tool: 'smart_compare_products', args },
                    pageContext: st && st.pageContext ? st.pageContext : null
                });
                return smart_compare_products(args, s);
            }
        };
        const canProceed = await ensureSubscriptionActiveOrNotify(socket, user_id);
        if (!canProceed) {
            return;
        }
        const stateForAnalysis = getUserState(user_id);
        let dbUserId = null;
        const platformUserId = user_id;
        const platform = 'Website';
        if (supabase && getBotId()) {
            const user = await getOrCreateUserRecord(platform, platformUserId);
            if (user && user.id != null) {
                dbUserId = user.id;
            }
        }
        socket.__dbUserId = dbUserId;
        socket.__platform = platform;
        socket.__platformUserId = platformUserId;
        if (dbUserId) {
            const tokenCount = typeof message === 'string' ? estimateTokens(message) : 0;
            const access = await subscriptionManager.checkFeatureAccess({
                userId: dbUserId,
                botId: getBotId(),
                action: 'send_message',
                messages: 1,
                tokens: tokenCount
            });
            if (!access.allowed) {
                await sendMessage(socket, "Your current plan has reached its message limit. Please upgrade to continue.", user_id);
                return;
            }
            await subscriptionManager.incrementUsage({
                userId: dbUserId,
                botId: getBotId(),
                messages: 1,
                tokens: tokenCount
            });
        }
        if (typeof message === 'string') {
            const now = Date.now();
            const normalized = String(message || '').trim().toLowerCase().replace(/\s+/g, ' ');
            const last = stateForAnalysis.lastInboundText != null ? String(stateForAnalysis.lastInboundText) : "";
            const lastAt = Number(stateForAnalysis.lastInboundAt) || 0;
            if (normalized && last && normalized === last && (now - lastAt) <= 1500) {
                return;
            }
            stateForAnalysis.lastInboundText = normalized;
            stateForAnalysis.lastInboundAt = now;
            setUserState(user_id, stateForAnalysis);
            if (stateForAnalysis && stateForAnalysis.humanHandoffActive) {
                if (dbUserId && supabase && getBotId()) {
                    const userId = dbUserId;
                    const source = platform === 'Website' ? 'Website' : 'WhatsApp';
                    await insertChatLogRecord({ userId, platformUserId: user_id, source, sender: 'User', message });
                }
                await routeMessage(socket, message, user_id);
                return;
            }
        }
        try {
            const analysis = await analyzeUserIntentMandatory(user_id, message);
            if (analysis) {
                stateForAnalysis.lastIntentAnalysis = analysis;
                stateForAnalysis.lastIntentAnalysisAt = new Date().toISOString();
                setUserState(user_id, stateForAnalysis);
            }
        } catch (e) {
            stateForAnalysis.lastIntentAnalysis = { error: e && e.message ? String(e.message) : "intent_analysis_failed" };
            stateForAnalysis.lastIntentAnalysisAt = new Date().toISOString();
            setUserState(user_id, stateForAnalysis);
        }
        const stateForLang = getUserState(user_id);
        if (typeof message === 'string') {
            try {
                const current = stateForLang.languageCode || 'auto';
                const langCode = await detectLanguageCode(message, current);
                stateForLang.languageCode = langCode;
                setUserState(user_id, stateForLang);
            } catch (e) {}
        }
        if (dbUserId && typeof message === 'string' && supabase && getBotId()) {
            const userId = dbUserId;
            const source = platform === 'Website' ? 'Website' : 'WhatsApp';
            const st = getUserState(user_id);
            await insertChatLogRecord({ userId, platformUserId: user_id, source, sender: 'User', message, conversationId: st && st.conversationId ? st.conversationId : null });
        }
        try {
            await routeMessage(socket, message, user_id);
        } catch (e) {
            try {
                console.error("❌ routeMessage failed:", e && e.message ? e.message : e);
            } catch (x) {}
            try {
                await sendMessage(socket, "Thoda issue aa gaya. Please ek baar phir try karo.", user_id);
            } catch (x) {}
        }
    });
    socket.on('clear_history', ({ user_id }) => {
        if (user_id) {
            conversationHistories.delete(user_id);
            const prev = userStates.get(user_id) || null;
            const next = createDefaultUserState();
            if (prev && typeof prev === 'object') {
                next.userName = prev.userName || null;
                next.namePrompted = !!prev.namePrompted;
                next.nameDeclined = !!prev.nameDeclined;
                next.email = prev.email || null;
                next.phone = prev.phone || null;
                next.contactPrompted = !!prev.contactPrompted;
                next.contactDeclined = !!prev.contactDeclined;
                next.languageCode = prev.languageCode || next.languageCode;
            }
            userStates.set(user_id, next);
        }
    });
    socket.on('disconnect', () => {
        const uid = socket.user_id;
        if (uid) {
            conversationHistories.delete(uid);
            liveUserSockets.delete(uid);
        }
        // Clean up polling interval if it exists
        if (socket.__agentMessagePollInterval) {
            clearInterval(socket.__agentMessagePollInterval);
            console.log("CLEANED_UP_POLLING_INTERVAL", { userId: uid });
        }
    });

    socket.on('analytics_event', async (payload) => {
        try {
            const data = payload || {};
            const userId = data.user_id || socket.user_id || null;
            if (!userId) return;
            if (data.page_context) {
                updateUserPageContext(userId, data.page_context);
            }
            const state = getUserState(userId);
            const pageCtx = state && state.pageContext ? state.pageContext : null;
            await logAnalyticsEvent({
                userId: socket.__dbUserId || null,
                platformUserId: userId,
                eventType: String(data.event_type || ''),
                payload: data,
                pageContext: pageCtx
            });
        } catch (e) {
            try {
                console.error("ANALYTICS_EVENT_ERROR", e && e.message ? e.message : e);
            } catch (x) {}
        }
    });
});


async function routeMessage(socket, message, user_id) {
    if (message && typeof message === 'object') {
        const type = message.type != null ? String(message.type) : '';
        if (type === 'HUMAN_ON') {
            const st = getUserState(user_id);
            st.humanHandoffActive = true;
            st.humanHandoffRequestedAt = new Date().toISOString();
            setUserState(user_id, st);
            const out = "Theek hai, main aapki chat human operator ke liye forward kar raha hoon. Agent online aate hi yahin par reply karega. Agar aap chaho to 'bot se baat karo' ya 'Switch to AI' button use karke wapas bot par aa sakte ho.";
            await sendMessage(socket, out, user_id);
            await sendMessage(socket, { type: '__CONTROL_HUMAN_MODE__', data: { active: true } }, user_id);
            return;
        }
        if (type === 'HUMAN_OFF') {
            const st = getUserState(user_id);
            st.humanHandoffActive = false;
            setUserState(user_id, st);
            const out = "Theek hai, ab main (bot) aapki madad karta rahunga.";
            await sendMessage(socket, out, user_id);
            await sendMessage(socket, { type: '__CONTROL_HUMAN_MODE__', data: { active: false } }, user_id);
            return;
        }
        if (type === 'PRODUCT_SELECT' || type === '__PRODUCT_SELECT__') {
            const data = message.data && typeof message.data === 'object' ? message.data : {};
            const selectionIndex = data.selectionIndex != null ? Number(data.selectionIndex) : null;
            const productId = data.productId != null ? String(data.productId) : null;
            const st = getUserState(user_id);
            const now = Date.now();
            const sig = `${selectionIndex != null ? selectionIndex : ''}|${productId || ''}`;
            const lastSig = st && typeof st.lastProductSelectSig === 'string' ? st.lastProductSelectSig : '';
            const lastAt = st && typeof st.lastProductSelectAt === 'number' ? st.lastProductSelectAt : 0;
            if (sig && sig === lastSig && (now - lastAt) <= 2000) {
                return;
            }
            if (st && typeof st === 'object') {
                st.lastProductSelectSig = sig;
                st.lastProductSelectAt = now;
                setUserState(user_id, st);
            }
            await describe_selected_product({ selectionText: 'details', selectionIndex, productId }, socket);
            return;
        }
    }
    let msg = typeof message === 'string' ? message : String(message || '');
    const state = getUserState(user_id);
    const nameChange = extractNameChange(msg);
    if (nameChange && nameChange.name) {
        pushConversation(state, 'user', msg);
        state.userName = nameChange.name;
        state.namePrompted = true;
        state.nameDeclined = false;
        state.awaitingName = false;
        if (!state.contactPrompted && !state.contactDeclined && !state.email && !state.phone) {
            state.awaitingContact = true;
            state.contactPrompted = true;
        } else {
            state.awaitingContact = false;
        }
        setUserState(user_id, state);
        if (state.awaitingContact) {
            const out = (botConfig.phrases.ask_contact || "Nice to meet you, {NAME}. Would you like to share your contact?")
                .replace('{NAME}', nameChange.name);
            await sendMessage(socket, out, user_id);
            pushConversation(state, 'bot', out);
            if (!nameChange.remainingText) return;
        } else {
            const out = (botConfig.phrases.welcome_name || "Nice to meet you, {NAME}.")
                .replace('{NAME}', nameChange.name);
            await sendMessage(socket, out, user_id);
            pushConversation(state, 'bot', out);
            if (!nameChange.remainingText) return;
        }
        msg = nameChange.remainingText;
    } else if (state && state.awaitingName) {
        if (isNameDeclineMessage(msg)) {
            pushConversation(state, 'user', msg);
            state.namePrompted = true;
            state.nameDeclined = true;
            state.awaitingName = false;
            setUserState(user_id, state);
            const out = botConfig.phrases.no_problem;
            await sendMessage(socket, out, user_id);
            pushConversation(state, 'bot', out);
            return;
        }
        const candidate = normalizeUserNameCandidate(msg);
        if (candidate) {
            pushConversation(state, 'user', msg);
            state.userName = candidate;
            state.namePrompted = true;
            state.nameDeclined = false;
            state.awaitingName = false;
            setUserState(user_id, state);
            if (!state.contactPrompted && !state.contactDeclined && !state.email && !state.phone) {
                state.awaitingContact = true;
                state.contactPrompted = true;
                setUserState(user_id, state);
                const out = (botConfig.phrases.ask_contact || "Nice to meet you, {NAME}. Would you like to share your contact?")
                    .replace('{NAME}', candidate);
                await sendMessage(socket, out, user_id);
                pushConversation(state, 'bot', out);
                return;
            }
            const out = (botConfig.phrases.welcome_name || "Nice to meet you, {NAME}. How can I help you today?")
                .replace('{NAME}', candidate);
            await sendMessage(socket, out, user_id);
            pushConversation(state, 'bot', out);
            return;
        }
        state.namePrompted = true;
        state.nameDeclined = true;
        state.awaitingName = false;
        setUserState(user_id, state);
    }
    if (state && state.awaitingContact) {
        if (isContactDeclineMessage(msg)) {
            pushConversation(state, 'user', msg);
            state.awaitingContact = false;
            state.contactPrompted = true;
            state.contactDeclined = true;
            setUserState(user_id, state);
            const out = botConfig.phrases.no_problem;
            await sendMessage(socket, out, user_id);
            pushConversation(state, 'bot', out);
            return;
        }
        const emailMatch = String(msg || '').match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i);
        const email = emailMatch ? String(emailMatch[0] || '').trim() : null;
        let remaining = String(msg || '');
        if (email) {
            pushConversation(state, 'user', msg);
            remaining = remaining.replace(email, ' ').trim();
        }
        let phone = null;
        if (!email) {
            const phoneLike = remaining.match(/\+?[0-9][0-9\s().-]{8,}[0-9]/);
            const normalized = phoneLike ? normalizePhoneCandidate(phoneLike[0]) : null;
            if (normalized) {
                pushConversation(state, 'user', msg);
                phone = normalized;
                remaining = remaining.replace(phoneLike[0], ' ').trim();
            }
        }
        if (email || phone) {
            state.email = email || state.email;
            state.phone = phone || state.phone;
            state.awaitingContact = false;
            state.contactPrompted = true;
            state.contactDeclined = false;
            setUserState(user_id, state);
            const out = botConfig.phrases.saved_success;
            await sendMessage(socket, out, user_id);
            pushConversation(state, 'bot', out);
            if (!remaining) return;
            msg = remaining;
        }
        state.awaitingContact = false;
        state.contactPrompted = true;
        state.contactDeclined = true;
        setUserState(user_id, state);
    }
    const lcMsg = String(msg || '').toLowerCase().trim();
    const isShowMore = /^(show(\s+me)?\s+more|show\s+more\s+products|more\s+products?)$/.test(lcMsg);
    if (isShowMore) {
        if (state && state.lastDisplayedCardsType) {
            await show_products({ search_scope: "continue", mode: "list", query_type: "search", search_text: msg }, socket);
            return;
        }
        if (state && Array.isArray(state.lastSearchResults) && state.lastSearchResults.length) {
            await show_more_products({}, socket);
            return;
        }
    }
    const hasShownProducts = state && Array.isArray(state.lastDisplayedProducts) && state.lastDisplayedProducts.length > 0;
    const asksProductDetails = hasShownProducts
        && /(about|details?|detail|info|information|describe|description|explain|bata|bta|batao|btao|btado|btana|batana|ba(re|are)\s*(me|m|mai)|ke\s+ba(re|are)\s*(me|m|mai)|ka\s+ba(re|are)\s*(me|m|mai)|jankari|janakari|specs?|features?)/i.test(lcMsg)
        && /(this|that|yeh?|ye|is|us|iska|uska|iske|uske|wali|wala|wale|product|item|option|first|1st|1|second|2nd|2|third|3rd|3|pehla|pahla|pehle|pahle|phle|dusra|dusri|doosra|doosri|dusre|teesra|tisra)/i.test(lcMsg);
    if (asksProductDetails) {
        await describe_selected_product({ selectionText: msg, userQuestion: msg }, socket);
        return;
    }
    const forcedCards = shouldForceCardsForMessage(msg);
    if (forcedCards) {
        if (state && typeof state === 'object') {
            state.lastResponseModeDecision = { mode: 'show_products', reason: `${forcedCards.type}_cards_request` };
            setUserState(user_id, state);
        }
        await show_products({ search_scope: "new", mode: "list", query_type: "search", search_text: msg }, socket);
        return;
    } else if (state && typeof state === 'object') {
        state.lastResponseModeDecision = null;
        setUserState(user_id, state);
    }
    try {
        await intentRouter.handleIntent(socket, msg, user_id);
    } catch (err) {
        console.error("❌ Error while routing message:", err && err.stack ? err.stack : err);
        await sendMessage(socket, "I'm temporarily unable to process that. Please try again in a moment.", user_id);
    }
}

function extractPreferencesFromHistory(history) {
    const text = history.map(m => (m.content || "").toLowerCase()).join(" ");
    let pref = [];

    if (text.includes("daily")) pref.push("daily wear");
    if (text.includes("office") || text.includes("formal")) pref.push("office wear");
    if (text.includes("comfortable") || text.includes("soft")) pref.push("comfort footwear");
    if (text.includes("casual")) pref.push("casual footwear");
    if (text.includes("heels")) pref.push("heels");
    if (text.includes("flats")) pref.push("flats");
    if (text.includes("black")) pref.push("black color");
    if (text.includes("beige")) pref.push("beige color");

    return pref.length ? pref.join(" ") : "best sellers";
}

async function handleToolCalls(socket, toolCalls, history, user_id) {
    const toolFunctions = {
        show_products,
        answer_general_question,
        retrieve_knowledge,
        get_contact_info,
        get_privacy_policy_info,
        get_links,
        attempt_to_solve_issue,
        raise_support_ticket,
        admin_mode,
        describe_selected_product,
        compare_recent_products,
        smart_compare_products
    };

    const toolPromises = toolCalls.map(toolCall => {
        const functionName = toolCall.function.name;
        const functionToCall = toolFunctions[functionName];
        const functionArgs = JSON.parse(toolCall.function.arguments);
        
        if (functionToCall) {
            return functionToCall(functionArgs, socket).then(functionResponse => ({
                tool_call_id: toolCall.id,
                role: "tool",
                name: functionName,
                content: functionResponse,
            }));
        }
        return Promise.resolve(null);
    });

    await Promise.all(toolPromises);
}

function formatMessageForWeb(message) {
    if (typeof message !== 'string') {
        return message; // Return non-string messages as is
    }

    let formattedMessage = message;

    const toSafeUrl = (raw) => {
        const u = String(raw || '').trim();
        if (!/^https?:\/\//i.test(u)) return null;
        return u.replace(/"/g, '%22');
    };
    const clickHereButton = (rawUrl) => {
        const safe = toSafeUrl(rawUrl);
        if (!safe) return 'click here';
        return `<a class="ext-link-btn" href="${safe}" target="_blank" rel="noopener noreferrer">click here</a>`;
    };

    formattedMessage = formattedMessage.replace(/!\[[^\]]*\]\([^\)]+\)/g, '');
    formattedMessage = formattedMessage.replace(/\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g, (_, url) => clickHereButton(url));
    formattedMessage = formattedMessage.replace(/<a\s+href="(https?:\/\/[^"]+)"[^>]*>[\s\S]*?<\/a>/gi, (_, url) => clickHereButton(url));
    formattedMessage = formattedMessage.replace(/(?<!href=")((https?:\/\/[^\s<)]+))/g, (_, url) => clickHereButton(url));
    formattedMessage = formattedMessage.replace(/(^|\n)\s*Image(?: of Product)?:.*?(?=\n|$)/g, '$1');

    formattedMessage = formattedMessage.replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1');

    // 1. Convert markdown-style lists (starting with - or *) into proper HTML lists
    // This looks for blocks of lines that start with a hyphen or asterisk
    const listRegex = /((?:(?:\n\s*[-*]\s.*))+)/g;
    formattedMessage = formattedMessage.replace(listRegex, (match) => {
        // For each matched block, create a <ul>
        const items = match.trim().split('\n');
        const listItems = items.map(item => `<li>${item.substring(2)}</li>`).join('');
        return `<ul>${listItems}</ul>`;
    });

    // 2. Convert any remaining newline characters to <br> tags
    // This is done last to avoid interfering with list detection
    formattedMessage = formattedMessage.replace(/\n/g, '<br>');
    
    // 3. Clean up any <br> tags that might appear right before or after a list
    formattedMessage = formattedMessage.replace(/<br><ul>/g, '<ul>');
    formattedMessage = formattedMessage.replace(/<\/ul><br>/g, '</ul>');

    return formattedMessage;
}


function sanitizeMessage(message) {
    return typeof message === 'string' ? message.replace(/[\#@*]/g, "") : message;
}

function normalizeUserNameCandidate(raw) {
    if (raw == null) return null;
    let s = String(raw).trim();
    s = s.replace(/^["'`]+|["'`]+$/g, '');
    s = s.replace(/[.?!,;:]+$/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) return null;
    if (s.length > 40) s = s.slice(0, 40).trim();
    if (!s) return null;
    if (/\d/.test(s)) return null;
    if (/https?:\/\//i.test(s)) return null;
    if (/[@#]/.test(s)) return null;
    if (!/^[a-zA-Z][a-zA-Z '\-]*$/.test(s)) return null;
    const words = s.split(' ').filter(Boolean);
    if (words.length > 4) return null;
    const lc = s.toLowerCase();
    if (['hi', 'hello', 'hey', 'namaste', 'thanks', 'thank you', 'ok', 'okay', 'yes', 'no', 'skip', 'later'].includes(lc)) return null;
    return s;
}

function isNameDeclineMessage(text) {
    const lc = String(text || '').toLowerCase();
    return /\b(skip|nope|nah|not\s+now|later|don'?t\s+want|do\s+not\s+want|prefer\s+not|no\s+thanks)\b/.test(lc);
}

function extractNameChange(text) {
    const s = String(text || '').trim();
    const m = s.match(/^(?:please\s+)?(?:call\s+me|you\s+can\s+call\s+me|my\s+name\s+is|i\s*am|i'?m|change\s+my\s+name\s+to|rename\s+me\s+to)\s+(.+)$/i);
    if (!m) return null;
    const after = String(m[1] || '').trim();
    let namePart = after;
    let remainingText = '';
    const split = after.match(/^(.+?)(?:\s*(?:,|;|\band\b)\s+)(.+)$/i);
    if (split) {
        namePart = String(split[1] || '').trim();
        remainingText = String(split[2] || '').trim();
    }
    const name = normalizeUserNameCandidate(namePart);
    if (!name) return null;
    return { name, remainingText };
}

function normalizeEmailCandidate(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const m = s.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i);
    if (!m) return null;
    return m[0];
}

function normalizePhoneCandidate(raw) {
    let s = String(raw || '').trim();
    if (!s) return null;
    s = s.replace(/[^\d+]/g, '');
    if (!s) return null;
    const digits = s.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 14) return null;
    if (!/^\+?\d{10,14}$/.test(s)) return null;
    return s;
}

function isContactDeclineMessage(text) {
    const lc = String(text || '').toLowerCase();
    return /\b(skip|nope|nah|not\s+now|later|don'?t\s+want|do\s+not\s+want|prefer\s+not|no\s+thanks)\b/.test(lc);
}

function limitWordsForChat(text, maxWords = 80) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    const words = s.split(' ').filter(Boolean);
    const cap = Number.isFinite(maxWords) && maxWords > 5 ? Math.floor(maxWords) : 80;
    if (words.length <= cap) return s;
    return `${words.slice(0, cap).join(' ')}…`;
}

function estimateTokens(text) {
    const s = String(text || '');
    if (!s) return 0;
    return Math.max(1, Math.ceil(s.length / 4));
}

async function sendMessage(socket, message, user_id) {
    try {
        let outgoing = message;
        let contentForDb = null;

        if (typeof message === 'string') {
            const sanitized = sanitizeMessage(message);
            const clipped = limitWordsForChat(sanitized);
            outgoing = formatMessageForWeb(clipped);
            contentForDb = clipped;
        } else if (message && typeof message === 'object' && message.type === 'message' && typeof message.data === 'string') {
            const sanitized = sanitizeMessage(message.data);
            const clipped = limitWordsForChat(sanitized);
            outgoing = { ...message, data: formatMessageForWeb(clipped) };
            contentForDb = clipped;
        }

        if (!socket || typeof socket.emit !== 'function') {
            return;
        }

        socket.emit('message', {
            user_id,
            message: outgoing
        });

        if (supabase && socket && socket.__dbUserId && contentForDb && getBotId()) {
            const userId = socket.__dbUserId;
            const platformUserId = socket.__platformUserId || user_id;
            const source = socket.__platform || (socket.isWhatsApp ? 'WhatsApp' : 'Website');
            const st = getUserState(platformUserId);
            await insertChatLogRecord({ userId, platformUserId, source, sender: 'Bot', message: contentForDb, conversationId: st && st.conversationId ? st.conversationId : null });
        }
    } catch (e) {
        console.error('❌ Failed to send message:', e.message);
    }
}

const ALLOWED_OPENAI_ROLES = new Set(['system', 'user', 'assistant', 'tool', 'function']);

function buildProductContext() {
    const cacheInfo = getProductCacheInfo();
    const products = Array.isArray(cacheInfo.data) ? cacheInfo.data : [];
    if (!products.length) {
        return `Available ${BRAND_NAME} products are currently not loaded.`;
    }
    const maxItems = 50;
    const items = products.slice(0, maxItems).map(p => {
        const name = p.name || '';
        const description = p.description || '';
        const price = p.price || '';
        const link = p.link || '';
        return `- ${name}: ${description}, Price: ${price}, Link: ${link}`;
    }).join('\n');
    return `Available ${BRAND_NAME} products (use ONLY these):\n\n${items}`;
}

function sanitizeOpenAIMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages
        .filter(m => m && typeof m === 'object')
        .map(m => {
            const copy = { ...m };
            let role = copy.role || 'user';

            // Normalize legacy/invalid roles
            if (role === 'bot') {
                role = 'assistant';
            }
            // Convert tool-role messages into assistant text so they are always valid
            if (role === 'tool') {
                const toolName = copy.name || 'tool';
                const existing = copy.content != null ? String(copy.content) : '';
                copy.content = `Tool ${toolName} result:\n${existing}`;
                role = 'assistant';
            }
            if (!ALLOWED_OPENAI_ROLES.has(role)) {
                role = 'assistant';
            }
            copy.role = role;

            if (typeof copy.content !== 'string' && copy.content != null) {
                copy.content = String(copy.content);
            } else if (copy.content == null) {
                copy.content = '';
            }

            return copy;
        });
}

function truncateMessagesForLLM(messages, maxChars) {
    if (!Array.isArray(messages) || !messages.length) return [];
    const limit = Number.isFinite(maxChars) && maxChars > 500 ? Math.floor(maxChars) : 1500;
    const outReversed = [];
    let used = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m || typeof m !== 'object') continue;
        const text = m.content != null ? String(m.content) : '';
        const len = text.length;
        if (used + len > limit && outReversed.length > 0) break;
        outReversed.push({ ...m, content: text });
        used += len;
    }
    return outReversed.reverse();
}

async function callOpenAI(messages, useTools = false, toolsOverride) {
    const maxTokens = Number(process.env.OPENAI_MAX_COMPLETION_TOKENS) || 700;
    const sanitizedMessages = sanitizeOpenAIMessages(messages);
    const truncatedMessages = truncateMessagesForLLM(sanitizedMessages, 1200);
    const hasSystemMessage = truncatedMessages.some((m) => m && m.role === 'system' && typeof m.content === 'string' && m.content.trim());
    const hasJsonInstruction = truncatedMessages.some((m) => {
        if (!m || m.role !== 'system' || typeof m.content !== 'string') return false;
        const s = m.content.toLowerCase();
        return s.includes('exactly one json object') || s.includes('only json') || s.includes('output only json') || s.includes('return exactly one json object');
    });
    const finalMessages = hasSystemMessage
        ? truncatedMessages
        : [{ role: 'system', content: SALES_SYSTEM_PROMPT }].concat(truncatedMessages);
    const payload = {
        model: GPT_MODEL,
        messages: finalMessages,
        max_completion_tokens: maxTokens
    };

    if (useTools) {
        payload.tools = toolsOverride || tools;
        payload.tool_choice = 'auto';
    } else if (hasJsonInstruction) {
        payload.response_format = { type: 'json_object' };
    }

    try {
        const timeoutMs = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS) || 15000;
        const completion = await Promise.race([
            openai.chat.completions.create(payload),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`OpenAI request timeout after ${timeoutMs}ms`)), timeoutMs))
        ]);
        const choice = completion.choices && completion.choices[0] ? completion.choices[0] : {};
        const message = choice.message || { role: 'assistant', content: '' };
        const extractPartText = (part) => {
            if (!part) return '';
            if (typeof part === 'string') return part;
            if (typeof part.text === 'string') return part.text;
            if (part.text && typeof part.text.value === 'string') return part.text.value;
            if (typeof part.value === 'string') return part.value;
            if (typeof part.content === 'string') return part.content;
            if (typeof part.refusal === 'string') return part.refusal;
            return '';
        };
        const normalizeMessageText = (msg) => {
            if (!msg || typeof msg !== 'object') return '';
            if (typeof msg.content === 'string' && msg.content.trim()) return msg.content.trim();
            if (Array.isArray(msg.content)) {
                const parts = msg.content
                    .map((part) => extractPartText(part))
                    .filter(Boolean);
                const joined = parts.join('\n').trim();
                if (joined) return joined;
            }
            if (typeof msg.refusal === 'string' && msg.refusal.trim()) return msg.refusal.trim();
            if (choice && typeof choice.text === 'string' && choice.text.trim()) return choice.text.trim();
            if (completion && typeof completion.output_text === 'string' && completion.output_text.trim()) return completion.output_text.trim();
            return '';
        };
        let normalizedText = normalizeMessageText(message);
        if (!normalizedText) {
            try {
                console.warn('OPENAI_EMPTY_TEXT_REPLY', {
                    model: GPT_MODEL,
                    hasJsonInstruction,
                    hasTools: !!useTools,
                    finishReason: choice && choice.finish_reason ? String(choice.finish_reason) : null,
                    hasArrayContent: Array.isArray(message && message.content),
                    hasRefusal: !!(message && typeof message.refusal === 'string' && message.refusal.trim()),
                    rawContentPreview: message && message.content ? String(message.content).slice(0, 500) : 'null'
                });
            } catch (e) {}
            if (!useTools) {
                try {
                    const lastUser = [...finalMessages].reverse().find((m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim());
                    const rescueMessages = [
                        { role: 'system', content: 'Reply in one short helpful sentence. Plain text only.' },
                        { role: 'user', content: lastUser ? String(lastUser.content).slice(0, 360) : 'Please reply briefly.' }
                    ];
                    const rescue = await Promise.race([
                        openai.chat.completions.create({ model: 'gpt-4o-mini', messages: rescueMessages, max_completion_tokens: 160 }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('OpenAI rescue timeout')), 8000))
                    ]);
                    const rescueChoice = rescue && rescue.choices && rescue.choices[0] ? rescue.choices[0] : {};
                    const rescueMsg = rescueChoice.message || {};
                    normalizedText = normalizeMessageText(rescueMsg);
                    if (!normalizedText && rescueChoice && typeof rescueChoice.text === 'string') {
                        normalizedText = rescueChoice.text.trim();
                    }
                    if (normalizedText) {
                        message.content = normalizedText;
                    }
                } catch (e) {}
            }
        }
        if (normalizedText && (typeof message.content !== 'string' || !message.content.trim())) {
            message.content = normalizedText;
        }
        logTokenUsage("agent_core", { model: GPT_MODEL }, completion, truncatedMessages);
        return {
            success: true,
            data: {
                raw: completion,
                message,
                text: normalizedText
            }
        };
    } catch (error) {
        const apiError = (error && error.response && error.response.data && error.response.data.error) || error;
        console.error('❌ Error calling OpenAI:', apiError);
        return { success: false, error: apiError };
    }
}

async function safeCallOpenAI(userId, messages, useTools = false, toolsOverride) {
    let result = await callOpenAI(messages, useTools, toolsOverride);

    if (!result.success && result.error) {
        console.warn(`⚠️ OpenAI error for user ${userId}. Retrying once without clearing memory.`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        result = await callOpenAI(messages, useTools, toolsOverride);
    }

    if (result && result.success && result.data && result.data.message && typeof result.data.message.content === 'string') {
        const text = result.data.message.content;
        const forbidden = ['nike', 'adidas', 'puma'];
        const lower = text.toLowerCase();
        const violates = forbidden.some(b => lower.includes(b));
        if (violates) {
            console.warn(`⚠️ OpenAI reply violated sales rules for user ${userId}. Retrying once without clearing memory.`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            result = await callOpenAI(messages, useTools, toolsOverride);
        }
    }

    return result;
}

async function getOrCreateUserRecord(platform, platformUserId) {
    if (!supabase || !getBotId() || !platformUserId) return null;
    const cacheKey = `${getBotId()}:${platform}:${platformUserId}`;
    if (userCache.has(cacheKey)) {
        const cached = userCache.get(cacheKey);
        try {
            if (cached && cached.id != null) {
                await subscriptionManager.getUserSubscription(String(cached.id));
            }
        } catch (e) {}
        return cached;
    }
    try {
        const { data: existing, error: selectError } = await supabase
            .from('users')
            .select('id, serial_number')
            .eq('platform_user_id', platformUserId)
            .eq('bot_id', getBotId())
            .limit(1);
        if (selectError) {
            console.error("Error in getOrCreateUserRecord (select):", selectError.message || selectError);
            return null;
        }
        if (Array.isArray(existing) && existing.length > 0 && existing[0].id != null) {
            userCache.set(cacheKey, existing[0]);
            try {
                await subscriptionManager.getUserSubscription(String(existing[0].id));
            } catch (e) {}
            return existing[0];
        }
        const nowIso = new Date().toISOString();
        let serialNumber = 1;
        const { data: last, error: lastError } = await supabase
            .from('users')
            .select('serial_number')
            .eq('bot_id', getBotId())
            .order('serial_number', { ascending: false })
            .limit(1);
        if (!lastError && Array.isArray(last) && last.length > 0 && last[0].serial_number != null) {
            const parsed = Number(last[0].serial_number);
            if (!Number.isNaN(parsed) && parsed >= 1) {
                serialNumber = parsed + 1;
            }
        }
        const { data: inserted, error: insertError } = await supabase
            .from('users')
            .insert({
                platform_user_id: platformUserId,
                bot_id: getBotId(),
                platform: platform || 'Website',
                serial_number: serialNumber,
                created_at: nowIso
            })
            .select('id, serial_number')
            .limit(1);
        if (insertError) {
            console.error("Error in getOrCreateUserRecord (insert):", insertError.message || insertError);
            return null;
        }
        if (Array.isArray(inserted) && inserted.length > 0 && inserted[0].id != null) {
            userCache.set(cacheKey, inserted[0]);
            try {
                await subscriptionManager.getUserSubscription(String(inserted[0].id));
            } catch (e) {}
            return inserted[0];
        }
        return null;
    } catch (e) {
        console.error("Error in getOrCreateUserRecord:", e.message);
        return null;
    }
}

async function insertChatLogRecord({ userId, platformUserId, source, sender, message, conversationId }) {
    if (!supabase || !getBotId() || !userId || !source || !sender || !message) return;
    const nowIso = new Date().toISOString();
    const platformValue = ['Website', 'WhatsApp', 'Telegram', 'Facebook'].includes(source) ? source : 'Website';
    let isHumanHandoff = false;
    let handoffStartedAt = null;
    if (platformUserId) {
        const state = getUserState(platformUserId);
        if (state && state.humanHandoffActive) {
            isHumanHandoff = true;
            handoffStartedAt = state.humanHandoffRequestedAt || nowIso;
        }
        try {
            console.log("HUMAN_HANDOFF_STATE", {
                platformUserId,
                isHumanHandoff,
                handoffStartedAt,
                state: state
                    ? {
                        humanHandoffActive: !!state.humanHandoffActive,
                        humanHandoffRequestedAt: state.humanHandoffRequestedAt || null
                    }
                    : null
            });
        } catch (e) {}
    }
    const logDbWrite = (variant) => {
        try {
            const msg = String(message || '');
            const clipped = msg.replace(/\s+/g, ' ').trim();
            const preview = clipped.length > 80 ? `${clipped.slice(0, 80)}…` : clipped;
            const safePreview = preview
                .replace(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/ig, '[redacted_email]')
                .replace(/\b(\+?\d[\d\s().-]{8,}\d)\b/g, '[redacted_phone]');
            console.log("DB_CHAT_LOG_INSERT", {
                variant,
                bot_id: getBotId(),
                chat_user_id: userId,
                platform: platformValue,
                sender,
                conversation_id: conversationId != null ? conversationId : null,
                at: nowIso,
                message_len: msg.length,
                message_preview: safePreview
            });
        } catch (e) {}
    };
    try {
        if (isHumanHandoff) {
            const payloadHuman = {
                chat_user_id: userId,
                bot_id: getBotId(),
                conversation_id: conversationId != null ? conversationId : null,
                sender,
                message,
                platform: platformValue,
                timestamp: nowIso,
                handoff_started_at: handoffStartedAt
            };
            try {
                const { error: humanErr } = await supabase.from('human_handoff_chat_logs').insert(payloadHuman);
                if (humanErr) {
                    console.error("❌ HUMAN_HANDOFF_DB_ERROR", humanErr && (humanErr.message || humanErr));
                } else {
                    logDbWrite("human_handoff");
                }
            } catch (e) {
                console.error("❌ HUMAN_HANDOFF_DB_EXCEPTION", e && (e.message || e));
            }
        }

        const payloadDash = {
            chat_user_id: userId,
            bot_id: getBotId(),
            conversation_id: conversationId != null ? conversationId : null,
            sender,
            message,
            platform: platformValue,
            timestamp: nowIso
        };
        const { error: dashErr } = await supabase.from('chat_logs').insert(payloadDash);
        if (!dashErr) {
            logDbWrite("dashboard_timestamp");
            return;
        }

        const payloadDashAlt = {
            chat_user_id: userId,
            bot_id: getBotId(),
            conversation_id: conversationId != null ? conversationId : null,
            sender,
            message,
            platform: platformValue,
            created_at: nowIso
        };
        const { error: dashAltErr } = await supabase.from('chat_logs').insert(payloadDashAlt);
        if (!dashAltErr) {
            logDbWrite("dashboard_created_at");
            return;
        }

        const payloadA = {
            user_id: userId,
            bot_id: getBotId(),
            source,
            sender,
            message,
            created_at: nowIso
        };
        if (platformUserId) {
            payloadA.platform_user_id = platformUserId;
        }
        const { error: errorA } = await supabase.from('chat_logs').insert(payloadA);
        if (!errorA) {
            logDbWrite("legacy");
            return;
        }

        console.error("❌ Supabase error inserting chat_logs record:", {
            dashErr: dashErr && (dashErr.message || dashErr),
            dashAltErr: dashAltErr && (dashAltErr.message || dashAltErr),
            legacyErr: errorA && (errorA.message || errorA)
        });
    } catch (e) {
        console.error("❌ Unexpected error inserting chat_logs record:", e && e.message ? e.message : e);
    }
}

async function fetchRecentConversationFromDb(dbUserId, limit = 8) {
    if (!supabase || !dbUserId || !getBotId()) return [];
    const take = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(10, Math.floor(limit))) : 8;
    const mapSenderRole = (s) => {
        const val = String(s || '').toLowerCase();
        if (val === 'user') return 'user';
        return 'assistant';
    };
    const normalizeRows = (rows) => {
        return rows
            .map(r => ({
                role: mapSenderRole(r && r.sender),
                content: r && r.message ? String(r.message) : ''
            }))
            .filter(m => m.content && (m.role === 'user' || m.role === 'assistant'));
    };
    try {
        const { data, error } = await supabase
            .from('chat_logs')
            .select('message, sender, timestamp, created_at')
            .eq('chat_user_id', dbUserId)
            .eq('bot_id', getBotId())
            .order('timestamp', { ascending: false })
            .limit(take);
        if (!error && Array.isArray(data) && data.length) {
            return normalizeRows(data).reverse();
        }
    } catch (e) {}
    try {
        const { data, error } = await supabase
            .from('chat_logs')
            .select('message, sender, timestamp, created_at')
            .eq('chat_user_id', dbUserId)
            .eq('bot_id', getBotId())
            .order('created_at', { ascending: false })
            .limit(take);
        if (!error && Array.isArray(data) && data.length) {
            return normalizeRows(data).reverse();
        }
    } catch (e) {}
    return [];
}

async function logAnalyticsEvent({ userId, platformUserId, eventType, payload, pageContext }) {
    if (!eventType) return;
    if (!supabase || !getBotId()) {
        try {
            console.log("ANALYTICS_EVENT_FALLBACK", {
                bot_id: getBotId(),
                chat_user_id: userId || null,
                platform_user_id: platformUserId || null,
                event_type: eventType,
                page_type: pageContext && pageContext.type ? String(pageContext.type) : null
            });
        } catch (e) {}
        return;
    }
    const nowIso = new Date().toISOString();
    const record = {
        bot_id: getBotId(),
        chat_user_id: userId || null,
        platform_user_id: platformUserId || null,
        event_type: eventType,
        page_type: pageContext && pageContext.type ? String(pageContext.type) : null,
        page_url: pageContext && pageContext.url ? String(pageContext.url) : null,
        payload: payload || {},
        created_at: nowIso
    };
    try {
        const { error } = await supabase.from('chat_analytics_events').insert(record);
        if (error) {
            console.error("❌ Supabase error inserting analytics record:", error && (error.message || error));
        } else {
            try {
                console.log("ANALYTICS_EVENT_INSERT", {
                    bot_id: record.bot_id,
                    chat_user_id: record.chat_user_id,
                    platform_user_id: record.platform_user_id,
                    event_type: record.event_type
                });
            } catch (e) {}
        }
    } catch (e) {
        console.error("❌ Unexpected error inserting analytics record:", e && e.message ? e.message : e);
    }
}

async function startServer() {
    await memoryStore.loadMemory();
    for (const [userId, rawState] of Object.entries(memoryStore.memoryCache)) {
        const sanitizedState = sanitizeUserStateObject(rawState) || getUserState(userId);
        userStates.set(userId, sanitizedState);
    }
    await refreshBotSubscriptionStatus(true);
    await new Promise((resolve, reject) => {
        const onError = (err) => {
            server.off('error', onError);
            reject(err);
        };
        server.on('error', onError);
        server.listen(PORT, () => {
            server.off('error', onError);
            resolve();
        });
    });
    console.log(`Server is live on port ${PORT}`);
    console.log('Chatbot is ready to serve!');

    (async () => {
        try {
            const products = await getLiveProducts();
            await vectorSearch.loadVectorIndex();
            await vectorSearch.buildVectorIndex(products);
            await vectorSearch.saveVectorIndex();
        } catch (e) {
            console.error("VECTOR_INDEX_WARNING", e && e.message ? e.message : e);
        }
        try {
            await updateKnowledgeBaseFromWebsite();
            await loadKnowledgeData();
        } catch (e) {
            console.error("KB_WARMUP_WARNING", e && e.message ? e.message : e);
        }
    })();
}

startServer().catch(err => {
    console.error("❌ A fatal error occurred during server startup:", err);
    process.exit(1);
});

