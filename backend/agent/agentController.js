const MAX_TOOL_CALL_DEPTH = 3;
const knowledgeBase = require('../knowledgebase');
const botConfig = require('../config/bot_prompts');
const companyConfig = botConfig.company;
const botBehaviorConfig = botConfig.behavior;
const botPrompts = botConfig.prompts;

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const welcomeNames = [companyConfig.company_name, companyConfig.chatbot_name].filter(Boolean).map(escapeRegex);
const welcomeRegex = welcomeNames.length
    ? new RegExp(`(^|\\n)\\s*Welcome to (${welcomeNames.join('|')})\\.[^\\n]*\\n?`, 'i')
    : /(^|\n)\s*Welcome to (Anhance|Anhance AI)\.[^\n]*\n?/i;

// yeh function OpenAI client use karke KB-based policy/support brain banata hai
function createAIBrain(deps) {
    const openai = deps && deps.openai ? deps.openai : null;
    const model = deps && deps.model ? deps.model : process.env.OPENAI_MODEL || "gpt-5-nano";

    if (!openai) {
        throw new Error("aiBrain requires an existing OpenAI client instance.");
    }

    async function callOpenAI(messages, options) {
        const maxTokens = Number(process.env.OPENAI_MAX_TOKENS_KB) || 160;
        const payload = {
            model,
            messages,
            max_completion_tokens: maxTokens
        };
        if (options && typeof options.temperature === "number") {
            payload.temperature = options.temperature;
        }
        if (options && typeof options.max_tokens === "number") {
            payload.max_completion_tokens = options.max_tokens;
        }
        const completion = await openai.chat.completions.create(payload);
        try {
            const usage = completion && completion.usage ? completion.usage : {};
            const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
            const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
            const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : null;
            console.log("LLM_CALL_METRICS", {
                source: "kb_brain",
                model,
                userId: null,
                promptTokens,
                completionTokens,
                totalTokens,
                inputChars: Array.isArray(messages) ? messages.reduce((sum, m) => {
                    const c = m && m.content != null ? String(m.content) : "";
                    return sum + c.length;
                }, 0) : null
            });
        } catch (e) {}
        const choice = completion && completion.choices && completion.choices[0] ? completion.choices[0] : {};
        const message = choice.message || { role: "assistant", content: "" };
        return message.content || "";
    }

    function normalizeKbResults(raw) {
        if (!raw) return [];
        const maxSnippets = 4;
        const maxChars = 800;
        const clip = (s) => {
            const text = String(s || "").trim();
            if (!text) return "";
            return text.length > maxChars ? text.slice(0, maxChars) : text;
        };
        if (Array.isArray(raw)) {
            return raw.map(item => {
                if (typeof item === "string") return clip(item);
                if (item == null) return "";
                return clip(item);
            }).filter(Boolean).slice(0, maxSnippets);
        }
        if (typeof raw === "string") {
            const trimmed = clip(raw);
            return trimmed ? [trimmed] : [];
        }
        if (typeof raw === "object") {
            if (Array.isArray(raw.matches) && raw.matches.length) {
                return raw.matches.map(text => clip(text)).filter(Boolean).slice(0, maxSnippets);
            }
            if (typeof raw.content === "string" && raw.content.trim()) {
                return raw.content
                    .split(/\n{2,}/)
                    .map(t => clip(t))
                    .filter(Boolean)
                    .slice(0, maxSnippets);
            }
        }
        return [];
    }

    function buildIdentitySystemPrompt() {
        const lines = botPrompts && Array.isArray(botPrompts.agentIdentitySystemPromptLines)
            ? botPrompts.agentIdentitySystemPromptLines
            : [];
        const out = (lines.length ? lines : [
            "You are an AI shopping and support assistant for this e-commerce website.",
            "Use ONLY the provided website text snippets as facts about products, pricing, and policies.",
            "Do not invent or guess prices, offers, dates, contacts, or brand claims.",
            "You may give simple, generic guidance when it is consistent with the snippets.",
            "Never give medical advice, never diagnose disease, and never promise guaranteed results.",
            "Use conversation history for context and continuity.",
            "Match the user's language/tone (Hindi/Hinglish must be written in English/Latin letters only).",
            "Write clean plain text. No Markdown, no links, no internal/system mentions.",
            "Answer only what is needed to resolve the user's intent and help them decide.",
            "Keep the final answer concise, ideally under 60 words."
        ]).join("\n");
        const brandName = companyConfig.company_name || companyConfig.chatbot_name || "Company";
        const chatbotName = companyConfig.chatbot_name || companyConfig.company_name || "Assistant";
        return String(out || "")
            .replace(/\{BRAND_NAME\}/g, brandName)
            .replace(/\{CHATBOT_NAME\}/g, chatbotName)
            .replace(/\{SUPPORT_EMAIL\}/g, companyConfig.support_email || "");
    }

    function buildMessages(params) {
        const rawSnippets = Array.isArray(params.kbSnippets) ? params.kbSnippets : [];
        const kbSnippets = rawSnippets.slice(0, 3).map(s => {
            const base = String(s || '');
            return base.replace(/\s+/g, " ").trim().slice(0, 320);
        });
        const userMessage = params.userMessage;
        const conversationHistory = Array.isArray(params.conversationHistory) ? params.conversationHistory : [];
        const maxHistory = 4;
        const maxUserChars = 480;

        const messages = [];

        messages.push({
            role: "system",
            content: buildIdentitySystemPrompt()
        });

        if (kbSnippets.length) {
            messages.push({
                role: "system",
                content: `Knowledge Base:\n${kbSnippets.join("\n\n")}`
            });
        }

        const historyTail = conversationHistory.slice(-maxHistory);
        historyTail.forEach(m => {
            if (!m || !m.content) return;
            const role = m.role === "assistant" || m.role === "user" ? m.role : "user";
            messages.push({
                role,
                content: String(m.content || "").slice(0, 360)
            });
        });

        messages.push({
            role: "user",
            content: String(userMessage || "").slice(0, maxUserChars)
        });

        return messages;
    }

    async function processMessage(args) {
        const userMessage = args.userMessage;
        const conversationHistory = Array.isArray(args.conversationHistory) ? args.conversationHistory : [];
        const knowledgeBase = args.knowledgeBase;

        let rawKbResults = null;

        if (knowledgeBase && typeof knowledgeBase.queryKnowledge === "function") {
            try {
                rawKbResults = await knowledgeBase.queryKnowledge({ query: userMessage });
            } catch (e) {
                rawKbResults = null;
            }
        }

        const kbSnippets = normalizeKbResults(rawKbResults);

        if (!kbSnippets || !kbSnippets.length) {
            return {
                action: "kb_not_found",
                reply: null,
                meta: {
                    kbHit: false
                }
            };
        }

        const messages = buildMessages({
            kbSnippets,
            userMessage,
            conversationHistory
        });

        const content = await callOpenAI(messages, { temperature: 0.3 });
        const reply = content || "";

        return {
            action: "kb_answer",
            reply,
            meta: {
                kbHit: true
            }
        };
    }

    return {
        processMessage
    };
}

function safeParseJson(text) {
    if (typeof text !== "string") return null;
    let raw = text.trim();
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
        raw = raw.slice(first, last + 1);
    }
    try {
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

function validateDecisionShape(obj) {
    if (!obj || typeof obj !== "object") return false;
    if (typeof obj.intent !== "string") return false;
    if (typeof obj.next_action !== "string") return false;
    if (typeof obj.user_message !== "string") return false;
    if (!(obj.tool === null || typeof obj.tool === "string")) return false;
    if (!(obj.tool_inputs === null || typeof obj.tool_inputs === "object")) return false;
    return true;
}

function buildDecisionMessages(params) {
    const baseMessages = Array.isArray(params.baseMessages) ? params.baseMessages : [];
    const lastUserMessage = typeof params.lastUserMessage === "string" ? params.lastUserMessage : "";
    const phase = params.phase === "final" ? "final" : "decide";
    const toolObservation = params.toolObservation;
    const stateSummary = typeof params.stateSummary === "string" ? params.stateSummary : "";
    const lastError = params.lastError;
    const maxUserChars = 360;
    const messages = [];
    messages.push({
        role: "system",
        content: [
            "You are the decision brain for the shopping and policy assistant.",
            "Use a strict internal reasoning pipeline before responding:",
            "1) Intent understanding, 2) Task analysis, 3) Reasoning, 4) Tool decision, 5) Information retrieval if needed, 6) Final answer plan.",
            "Do not reveal this reasoning. Output only the required JSON.",
            "Return exactly one JSON object with fields: intent, next_action, tool, tool_inputs, user_message.",
            "No extra text before or after the JSON.",
            "If no tool is needed, set tool and tool_inputs to null.",
            "Valid intents: product_recommendation, product_information, policy_question, support_issue, general_conversation, comparison_request.",
            "Valid next_action values: reply, call_tool, retrieve_knowledge, ask_clarification.",
            "If the user query is ambiguous, choose ask_clarification and ask exactly one short question in user_message.",
            phase === "final"
                ? "Final phase: never call a tool; set tool to null and only fill user_message."
                : "Decide phase: you may choose at most one tool. If you call a tool, user_message must be an empty string.",
            stateSummary ? "Session state: " + stateSummary : "",
            lastError ? "Previous attempt error: " + lastError : ""
        ].filter(Boolean).join("\n")
    });
    if (toolObservation != null) {
        messages.push({
            role: "system",
            content: "Latest tool_result (JSON or text): " + truncateForLLMText(typeof toolObservation === "string" ? toolObservation : JSON.stringify(toolObservation), 1200)
        });
    }
    baseMessages.forEach(m => messages.push(m));
    const trimmedUserMessage = lastUserMessage ? String(lastUserMessage).slice(0, maxUserChars) : "";
    if (trimmedUserMessage) {
        messages.push({ role: "user", content: trimmedUserMessage });
    }
    return messages;
}

async function getPlainFallbackReply(callOpenAI, lastUserMessage, state) {
    const content = String(lastUserMessage || "").trim();
    if (!content) return "";
    const messages = [
        { role: "system", content: "Reply in plain text. No JSON. No tool calls. Keep it short and helpful." }
    ];
    const langCode = state && state.languageCode ? String(state.languageCode) : "auto";
    if (langCode && langCode !== "auto") {
        if (langCode === "hi") {
            messages.push({ role: "system", content: "Reply in Hinglish (Hindi in English letters). No Devanagari." });
        } else {
            messages.push({ role: "system", content: `Reply only in language code "${langCode}".` });
        }
    }
    messages.push({ role: "user", content: content.slice(0, 360) });
    const resp = await callOpenAI(messages, false);
    const text = resp && resp.success && resp.data
        ? (typeof resp.data.text === "string" && resp.data.text.trim()
            ? resp.data.text.trim()
            : (resp.data.message && typeof resp.data.message.content === "string"
                ? resp.data.message.content.trim()
                : ""))
        : "";
    return text;
}

const runReasoning = async ({ baseMessages, lastUserMessage, stateSummary, callOpenAI, toolObservation, phase }) => {
    const maxAttempts = 2;
    let lastError = null;
    let lastRaw = "";
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
        const messages = buildDecisionMessages({
            baseMessages,
            lastUserMessage,
            stateSummary,
            toolObservation,
            phase,
            lastError
        });
        const resp = await callOpenAI(messages, false);
        if (!resp || !resp.success || !resp.data || !resp.data.message) {
            lastError = "llm_call_failed";
            continue;
        }
        const raw = (typeof resp.data.text === "string" && resp.data.text.trim())
            ? resp.data.text
            : (resp.data.message.content || "");
        lastRaw = typeof raw === "string" ? raw : String(raw || "");
        const parsed = safeParseJson(raw);
        if (!validateDecisionShape(parsed)) {
            const trimmed = String(lastRaw || "").trim();
            if (trimmed) {
                return {
                    success: true,
                    decision: {
                        intent: "general",
                        next_action: "reply",
                        tool: null,
                        tool_inputs: null,
                        user_message: trimmed
                    }
                };
            }
            lastError = "schema_violation";
            continue;
        }
        const decision = {
            intent: parsed.intent,
            next_action: parsed.next_action,
            tool: parsed.tool,
            tool_inputs: parsed.tool_inputs,
            user_message: parsed.user_message
        };
        return { success: true, decision };
    }
    const trimmed = String(lastRaw || "").trim();
    if (trimmed) {
        return {
            success: true,
            decision: {
                intent: "general",
                next_action: "reply",
                tool: null,
                tool_inputs: null,
                user_message: trimmed
            }
        };
    }
    return { success: false, error: lastError || "decision_failed", raw: lastRaw };
};

function summarizeStateForLLM(state) {
    if (!state || typeof state !== 'object') return 'none';
    const preferences = state.preferences || {};
    const recentProducts = Array.isArray(state.recentProductsHistory)
        ? state.recentProductsHistory.slice(-4).map(p => ({
            id: p && p.id,
            name: p && p.name
        }))
        : [];
    const lastDisplayed = Array.isArray(state.lastDisplayedProducts)
        ? state.lastDisplayedProducts.slice(-4).map(p => ({
            id: p && p.id,
            name: p && p.name
        }))
        : [];
    const lastDetailed = state.lastDetailedProduct
        ? {
            id: state.lastDetailedProduct.id,
            name: state.lastDetailedProduct.name
        }
        : null;
    const lastQueryProductsCount = Array.isArray(state.lastQueryProducts)
        ? state.lastQueryProducts.length
        : (Array.isArray(state.lastSearchResults) ? state.lastSearchResults.length : 0);
    const productViewIndex = Number.isFinite(Number(state.productViewIndex)) ? Number(state.productViewIndex) : 0;
    const page = state.pageContext || null;
    return JSON.stringify({
        lang: state.languageCode,
        prefs: preferences,
        lastDetail: lastDetailed,
        lastShown: lastDisplayed,
        recent: recentProducts,
        lastCount: lastQueryProductsCount,
        index: productViewIndex,
        page
    });
}

function summarizeToolsForContext(toolsList) {
    const tools = Array.isArray(toolsList) ? toolsList : [];
    const out = [];
    for (const t of tools) {
        const fn = t && t.function ? t.function : null;
        if (!fn || !fn.name) continue;
        const params = fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : null;
        const required = Array.isArray(params && params.required) ? params.required : [];
        const props = params && params.properties && typeof params.properties === 'object'
            ? Object.keys(params.properties)
            : [];
        out.push({
            name: String(fn.name),
            description: fn.description ? String(fn.description) : "",
            required,
            fields: props
        });
    }
    return out.slice(0, 20);
}

function buildContextPayload(state, lastUserMessage, toolsList) {
    const conversationHistory = Array.isArray(state && state.conversationContext)
        ? state.conversationContext.slice(-5).map(m => ({
            role: m && m.role ? String(m.role) : "user",
            content: m && m.content ? String(m.content) : ""
        }))
        : [];
    const kbSnippets = Array.isArray(state && state.lastKnowledgeSnippets)
        ? state.lastKnowledgeSnippets.slice(0, 4).map(s => String(s || "")).filter(Boolean)
        : [];
    const knowledge = kbSnippets.length ? kbSnippets : [];
    const tools = summarizeToolsForContext(toolsList);
    return {
        user_message: String(lastUserMessage || ""),
        recent_conversation: conversationHistory,
        session_memory: summarizeStateForLLM(state),
        knowledge_snippets: knowledge,
        available_tools: tools
    };
}

function applyPolicy(state, decision, phase) {
    const baseDecision = decision && typeof decision === 'object' ? decision : {};
    const out = {
        intent: baseDecision.intent,
        next_action: baseDecision.next_action,
        tool: baseDecision.tool,
        tool_inputs: baseDecision.tool_inputs,
        user_message: baseDecision.user_message
    };
    const s = state && typeof state === 'object' ? state : {};
    const stage = s.salesStage || null;
    const isQualified = stage === 'qualified';
    if (out.tool === 'book_call' && !isQualified) {
        out.tool = null;
        out.tool_inputs = null;
        out.next_action = 'ask_qualification_questions';
        if (!out.user_message || !String(out.user_message).trim()) {
            out.user_message = "Before booking a call, I need a few quick qualification details.";
        }
    }
    if (out.tool === 'send_pricing' && !s.budgetConfirmed) {
        out.tool = null;
        out.tool_inputs = null;
        out.next_action = 'clarify_budget';
        if (!out.user_message || !String(out.user_message).trim()) {
            out.user_message = "Can you share your approximate budget so I can give the most relevant pricing options?";
        }
    }
    if (out.tool === 'handoff_to_human' && s.humanHandoffLocked === true) {
        out.tool = null;
        out.tool_inputs = null;
        out.next_action = 'continue_as_bot';
        if (!out.user_message || !String(out.user_message).trim()) {
            out.user_message = "For now I will continue helping you directly here.";
        }
    }
    return out;
}

function truncateForLLMText(content, maxLen) {
    const text = typeof content === 'string' ? content : String(content || '');
    const limit = Number.isFinite(maxLen) && maxLen > 50 ? maxLen : 1200;
    if (text.length <= limit) return text;
    const headLen = Math.max(200, Math.floor(limit * 0.7));
    const tailLen = Math.max(100, limit - headLen - 20);
    const head = text.slice(0, headLen);
    const tail = text.slice(-tailLen);
    return `${head}\n...\n${tail}`;
}

function normalizeDecisionKbResults(raw) {
    if (!raw) return [];
    const maxSnippets = 4;
    const maxChars = 320;
    const clip = (s) => {
        const text = String(s || '').replace(/\s+/g, ' ').trim();
        if (!text) return "";
        return text.length > maxChars ? text.slice(0, maxChars) : text;
    };
    const collected = [];
    if (Array.isArray(raw.matches) && raw.matches.length) {
        raw.matches.forEach((item) => {
            if (item == null) return;
            if (typeof item === 'string') {
                const c = clip(item);
                if (c) collected.push(c);
            } else if (item && typeof item.content === 'string') {
                const c = clip(item.content);
                if (c) collected.push(c);
            }
        });
    } else if (typeof raw.content === 'string' && raw.content.trim()) {
        raw.content
            .split(/\n{2,}/)
            .forEach((t) => {
                const c = clip(t);
                if (c) collected.push(c);
            });
    }
    const seen = new Set();
    const deduped = [];
    for (const s of collected) {
        const key = s.toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        deduped.push(s);
        if (deduped.length >= maxSnippets) break;
    }
    return deduped;
}

function validateRouterShape(obj) {
    if (!obj || typeof obj !== "object") return false;
    if (typeof obj.intent !== "string") return false;
    if (typeof obj.agent !== "string") return false;
    if (!(obj.tool === null || typeof obj.tool === "string")) return false;
    if (!(obj.tool_inputs === null || typeof obj.tool_inputs === "object")) return false;
    if (typeof obj.confidence !== "number") return false;
    return true;
}

function detectKnowledgeRouting(userMessage) {
    const text = String(userMessage || '').toLowerCase().trim();
    if (!text) return null;
    const isGreetingOnly = /^(hi|hii|hello|hey|namaste|yo|ok|okay|thanks|thank you)\b/.test(text);
    if (isGreetingOnly) return null;
    if (/\b(privacy|data\s*privacy|personal\s*data|personal\s*information)\b/.test(text)) {
        return {
            intent: "policy_question",
            agent: "knowledge_agent",
            tool: "get_privacy_policy_info",
            tool_inputs: { userQuery: String(userMessage || "") },
            confidence: 0.98
        };
    }
    if (/\b(contact|support|customer\s*care|email|phone|whatsapp|helpline|help\s*line)\b/.test(text)) {
        return {
            intent: "policy_question",
            agent: "knowledge_agent",
            tool: "get_contact_info",
            tool_inputs: { userQuery: String(userMessage || "") },
            confidence: 0.98
        };
    }
    if (/\b(return|refund|exchange|replacement|replace|shipping|delivery|dispatch|courier|shipment|tracking|track|policy|warranty|payment|cod|cancel|terms|legal|about|company|brand|mission|vision|services|pricing|price|plan|plans|cost|charges|order\s*tracking)\b/.test(text)) {
        return {
            intent: "policy_question",
            agent: "knowledge_agent",
            tool: "retrieve_knowledge",
            tool_inputs: { query: String(userMessage || ""), max_snippets: 3, max_chars: 400 },
            confidence: 0.96
        };
    }
    return null;
}

function normalizeRouterDecision(raw, lastUserMessage) {
    const forcedKnowledge = detectKnowledgeRouting(lastUserMessage);
    if (forcedKnowledge) {
        return forcedKnowledge;
    }
    const out = {
        intent: "general_conversation",
        agent: "conversation_agent",
        tool: null,
        tool_inputs: null,
        confidence: 0.2
    };
    if (!raw || typeof raw !== "object") return out;
    const intent = typeof raw.intent === "string" ? raw.intent : out.intent;
    const agent = typeof raw.agent === "string" ? raw.agent : out.agent;
    const tool = raw.tool === null || typeof raw.tool === "string" ? raw.tool : null;
    const tool_inputs = raw.tool_inputs && typeof raw.tool_inputs === "object" ? raw.tool_inputs : null;
    const confidence = typeof raw.confidence === "number" ? raw.confidence : out.confidence;
    out.intent = intent;
    out.agent = agent;
    out.tool = tool;
    out.tool_inputs = tool_inputs;
    out.confidence = confidence;
    if (!out.tool && out.agent === "knowledge_agent") {
        out.tool = "retrieve_knowledge";
        out.tool_inputs = { query: String(lastUserMessage || ""), max_snippets: 3, max_chars: 400 };
    }
    if (out.tool === "retrieve_knowledge" && (!out.tool_inputs || !out.tool_inputs.query)) {
        out.tool_inputs = { query: String(lastUserMessage || ""), max_snippets: 3, max_chars: 400 };
    }
    if (out.tool === "show_products" && (!out.tool_inputs || !out.tool_inputs.search_text)) {
        out.tool_inputs = { search_scope: "new", mode: "list", query_type: "search", search_text: String(lastUserMessage || "") };
    }
    if (out.tool === "describe_selected_product") {
        const current = out.tool_inputs && typeof out.tool_inputs === "object" ? out.tool_inputs : {};
        out.tool_inputs = {
            ...current,
            selectionText: current.selectionText || String(lastUserMessage || ""),
            userQuestion: current.userQuestion || String(lastUserMessage || "")
        };
    }
    if (out.tool === "get_links") {
        const current = out.tool_inputs && typeof out.tool_inputs === "object" ? out.tool_inputs : {};
        out.tool_inputs = {
            ...current,
            userQuery: current.userQuery || String(lastUserMessage || "")
        };
    }
    return out;
}

async function runRouterDecision(callOpenAI, lastUserMessage, recentConversation, state) {
    const contextLines = Array.isArray(recentConversation)
        ? recentConversation.map(m => {
            const role = m && m.role === 'assistant' ? 'Assistant' : 'User';
            const content = m && m.content ? String(m.content).replace(/\s+/g, ' ').trim() : '';
            return content ? `${role}: ${content}` : '';
        }).filter(Boolean).join('\n')
        : '';
    const system = [
        "You are a router that selects ONE agent for the user request.",
        "Return ONLY JSON with fields: intent, agent, tool, tool_inputs, confidence.",
        "Agents: knowledge_agent, product_agent, support_agent, conversation_agent.",
        "Intents: product_recommendation, product_information, policy_question, support_issue, general_conversation, comparison_request.",
        "Tools: show_products, describe_selected_product, compare_recent_products, smart_compare_products, retrieve_knowledge, attempt_to_solve_issue, raise_support_ticket, get_contact_info, get_privacy_policy_info, get_links, admin_mode, null.",
        "CRITICAL: For questions about what the company does, services provided, or brand info, ALWAYS use knowledge_agent and retrieve_knowledge tool.",
        "CRITICAL: For shopping, buying, seeing products, or catalog requests, ALWAYS use product_agent and show_products tool.",
        "CRITICAL: If the user asks for more info about a specific product already shown, or refers to this/that/first/second/current product, ALWAYS use describe_selected_product instead of show_products.",
        "CRITICAL: If the user asks for the link/url/buy page of a shown or selected product, ALWAYS use get_links.",
        "If unclear or low confidence, use conversation_agent and tool null.",
        "Keep tool_inputs minimal.",
        state && state.mode === 'admin' ? "Admin mode active: choose tool admin_mode when relevant." : ""
    ].filter(Boolean).join("\n");
    const messages = [
        { role: "system", content: system },
        { role: "user", content: `Conversation History:\n${contextLines || "(none)"}\n\nCurrent User Message:\n${String(lastUserMessage || "")}`.slice(0, 1200) }
    ];
    const resp = await callOpenAI(messages, false);
    const raw = resp && resp.success && resp.data
        ? (typeof resp.data.text === "string" && resp.data.text.trim()
            ? resp.data.text.trim()
            : (resp.data.message && typeof resp.data.message.content === "string" ? resp.data.message.content.trim() : ""))
        : "";
    const parsed = safeParseJson(raw);
    if (!validateRouterShape(parsed)) {
        return normalizeRouterDecision(null, lastUserMessage);
    }
    return normalizeRouterDecision(parsed, lastUserMessage);
}

async function processAIResponse(socket, user_id, history) {
    const getSystemPrompt = socket.__getSystemPrompt;
    const sendMessage = socket.__sendMessage;
    const callOpenAI = socket.__callOpenAI;
    const getUserState = socket.__getUserState;
    const setUserState = socket.__setUserState;
    const pushConversation = socket.__pushConversation;
    const toolFns = socket.__toolFns || {};

    try {
        const state = getUserState(user_id) || {};
        const isAdmin = state.mode === 'admin';
        let lastUserMessage = "";
        if (Array.isArray(history)) {
            for (let i = history.length - 1; i >= 0; i--) {
                const m = history[i];
                if (m && m.role === 'user' && m.content) {
                    lastUserMessage = String(m.content);
                    break;
                }
            }
        }
        const lcUser = String(lastUserMessage || "").toLowerCase();
        const hasDisplayed = Array.isArray(state.lastDisplayedProducts) && state.lastDisplayedProducts.length > 0;
        const compareIntent = /(compare|comparison|difference|diff\b|farak|fark|farq|frk|antar|between\b|vs\b|versus|which\s+is\s+better|better\s+for|kaunsa\s+better|kaun\s+sa\b)/i.test(lcUser);
        if (hasDisplayed && !compareIntent) {
            const ordMap = {
                first: 0,
                '1st': 0,
                '1': 0,
                pehla: 0,
                pahla: 0,
                pehle: 0,
                pahle: 0,
                phle: 0,
                second: 1,
                '2nd': 1,
                '2': 1,
                dusra: 1,
                dusri: 1,
                doosra: 1,
                doosri: 1,
                dusre: 1,
                third: 2,
                '3rd': 2,
                '3': 2,
                teesra: 2,
                tisra: 2
            };
            const ordMatch = lcUser.match(/\b(first|1st|1|second|2nd|2|third|3rd|3|pehla|pahla|pehle|pahle|phle|dusra|dusri|doosra|doosri|dusre|teesra|tisra)\b/);
            const hasPronoun = /(this|that|yeh?|ye|wo|woh|us|iska|uska|is\s+ka|us\s+ka|wali|wala|wale|iske|uske)/i.test(lcUser);
            const wantsInfo = /(about|details?|detail|info|information|describe|description|explain|bata|bta|batao|btao|btado|btana|batana|ba(re|are)\s*(me|m|mai)|ke\s+ba(re|are)\s*(me|m|mai)|ka\s+ba(re|are)\s*(me|m|mai)|jankari|janakari|specs?|features?)/i.test(lcUser);
            const hasProductRef = /\b(product|item|option|wali|wala|wale)\b/.test(lcUser);
            if ((ordMatch || hasPronoun) && (wantsInfo || hasProductRef)) {
                let selectionIndex = 0;
                if (ordMatch && ordMatch[1] && ordMap[ordMatch[1]] != null) {
                    selectionIndex = ordMap[ordMatch[1]];
                }
                const directDescribe = toolFns.describe_selected_product;
                if (typeof directDescribe === 'function') {
                    await directDescribe({ selectionText: lastUserMessage, selectionIndex, userQuestion: lastUserMessage }, socket);
                    return;
                }
            }
        }
        const baseMessages = [];
        if (isAdmin && typeof getSystemPrompt === 'function') {
            baseMessages.push({ role: 'system', content: getSystemPrompt(true) });
        }
        const guard = state && state.lastResponseModeDecision && typeof state.lastResponseModeDecision === 'object'
            ? state.lastResponseModeDecision
            : null;
        if (guard && guard.mode) {
            const mode = String(guard.mode);
            const reason = guard.reason ? String(guard.reason) : '';
            const lines = [];
            lines.push(`External guardrail response_mode="${mode}". You MUST obey this decision strictly.`);
            if (mode === 'show_products') {
                lines.push("You MUST call show_products in this turn and MUST NOT reply with only text or optional preference questions before showing products.");
            } else if (mode === 'describe_only') {
                lines.push("Do NOT call show_products. Either call describe_selected_product or answer in plain text if appropriate.");
            } else if (mode === 'ask_clarification') {
                lines.push("You MUST ask exactly one short clarifying question and MUST NOT call any product tool yet.");
            }
            if (reason) {
                lines.push(`Guardrail reason: ${reason}`);
            }
            baseMessages.push({
                role: 'system',
                content: lines.join(' ')
            });
        }
        if (state && typeof state.userName === 'string' && state.userName.trim()) {
            baseMessages.push({
                role: 'system',
                content: `User name: "${state.userName.trim()}". Use it naturally but not too often.`
            });
        }
        if (state && (typeof state.email === 'string' && state.email.trim() || typeof state.phone === 'string' && state.phone.trim())) {
            const email = typeof state.email === 'string' ? state.email.trim() : '';
            const phone = typeof state.phone === 'string' ? state.phone.trim() : '';
            baseMessages.push({
                role: 'system',
                content: `Saved contact info (do not repeat unless asked): ${JSON.stringify({ email, phone })}.`
            });
        }
        const toolNames = Array.isArray(socket.__tools)
            ? socket.__tools.map((t) => t && t.function ? t.function.name : null).filter(Boolean)
            : [];
        const toolList = toolNames.length ? toolNames.join(', ') : 'none';
        const hasRetrieveKnowledge = toolNames.includes('retrieve_knowledge');
        const hasSmartCompare = toolNames.includes('smart_compare_products');
        const toolRules = [
            `Tools: ${toolList}.`,
            hasRetrieveKnowledge ? 'If you need verified website facts, call retrieve_knowledge first.' : '',
            hasSmartCompare ? 'Clear comparison questions => smart_compare_products(userQuestion).' : '',
            'If no tool needed, tool = null and reply in user_message.'
        ].filter(Boolean).join(' ');
        baseMessages.push({
            role: 'system',
            content: toolRules
        });
        const convo = Array.isArray(state.conversationContext) ? state.conversationContext.slice(-5) : [];
        if (convo.length) {
            const formatted = convo.map(m => {
                const role = m && m.role === 'assistant' ? 'Assistant' : 'User';
                const content = m && m.content ? String(m.content).replace(/\s+/g, ' ').trim() : '';
                return content ? `${role}: ${content}` : '';
            }).filter(Boolean).join('\n');
            if (formatted) {
                baseMessages.push({ role: 'system', content: `Conversation History:\n${formatted}` });
            }
        }
        const forcedKnowledge = detectKnowledgeRouting(lastUserMessage);
        if (forcedKnowledge) {
            const fn = toolFns[forcedKnowledge.tool];
            if (typeof fn === 'function') {
                const toolResult = await fn(forcedKnowledge.tool_inputs || {}, socket);
                if (forcedKnowledge.tool === "get_privacy_policy_info" || forcedKnowledge.tool === "get_contact_info") {
                    return;
                }
                const langCode = state && state.languageCode ? String(state.languageCode) : 'auto';
                const finalMessages = [
                    { role: 'system', content: "You are the official AI sales and support assistant for the company. Use ONLY verified website/tool information for facts about the company, policies, pricing, contact, and support. If information is missing, say so plainly." }
                ];
                if (langCode && langCode !== 'auto') {
                    if (langCode === 'hi') {
                        finalMessages.push({ role: 'system', content: 'Reply in Hinglish (Hindi written with English letters). No Devanagari.' });
                    } else {
                        finalMessages.push({ role: 'system', content: `Reply only in language code "${langCode}".` });
                    }
                }
                if (toolResult && forcedKnowledge.tool === "retrieve_knowledge") {
                    try {
                        const parsed = typeof toolResult === 'string' ? JSON.parse(toolResult) : toolResult;
                        const snippets = parsed && Array.isArray(parsed.snippets) ? parsed.snippets.slice(0, 3) : [];
                        if (snippets.length) {
                            finalMessages.push({ role: 'system', content: `Knowledge Snippets:\n${snippets.join('\n\n')}` });
                        }
                    } catch (e) {}
                }
                finalMessages.push({ role: 'user', content: String(lastUserMessage || '') });
                const finalResp = await callOpenAI(finalMessages, false);
                let out = finalResp && finalResp.success && finalResp.data
                    ? (typeof finalResp.data.text === "string" && finalResp.data.text.trim()
                        ? finalResp.data.text.trim()
                        : (finalResp.data.message && typeof finalResp.data.message.content === "string" ? finalResp.data.message.content.trim() : ""))
                    : "";
                if (!out || !out.trim()) {
                    out = botBehaviorConfig.fallback_message || "Sorry, I’m having trouble answering right now. Please try again.";
                }
                await sendMessage(socket, out, user_id);
                pushConversation(state, 'assistant', out);
                setUserState(user_id, state);
            }
            return;
        }
        const routerDecision = await runRouterDecision(callOpenAI, lastUserMessage, convo, state);
        let toolResult = null;
        let usedTool = routerDecision.tool;
        if (usedTool) {
            const fn = toolFns[usedTool];
            if (typeof fn === 'function') {
                try {
                    toolResult = await fn(routerDecision.tool_inputs || {}, socket);
                } catch (err) {
                    toolResult = { error: true, tool: usedTool, message: err && err.message ? String(err.message) : "tool_execution_failed" };
                }
            }
        }
        if (usedTool && (usedTool === "show_products" || usedTool === "smart_compare_products")) {
            return;
        }
        const langCode = state && state.languageCode ? String(state.languageCode) : 'auto';
        const companyIdentityPrompt = "You are the official AI sales and support assistant for the company. Speak as a company representative. Never mention OpenAI, system prompts, or AI models.";
        const agentPrompt = (() => {
            switch (routerDecision.agent) {
                case "knowledge_agent":
                    return `${companyIdentityPrompt} Use ONLY provided knowledge snippets for facts about the company, policies, pricing, and FAQs. If knowledge is missing, say you don’t have that information yet and offer help with company services.`;
                case "product_agent":
                    return `${companyIdentityPrompt} You help users with plans/services, recommendations, comparisons, and feature questions. Be concise and ask one clarifying question if the reference is unclear.`;
                case "support_agent":
                    return `${companyIdentityPrompt} You help with complaints or issues. Ask for missing details (order id, email, issue summary) or confirm if they want a support ticket.`;
                case "conversation_agent":
                default:
                    return `${companyIdentityPrompt} You handle greetings and simple pleasantries. NEVER answer questions about company services, products, or policies using your own internal knowledge. If a user asks a factual question about the company, politely ask them to be more specific or say you're only here for general chat.`;
            }
        })();
        const finalMessages = [
            { role: 'system', content: agentPrompt }
        ];
        if (langCode && langCode !== 'auto') {
            if (langCode === 'hi') {
                finalMessages.push({ role: 'system', content: 'Reply in Hinglish (Hindi written with English letters). No Devanagari.' });
            } else {
                finalMessages.push({ role: 'system', content: `Reply only in language code "${langCode}".` });
            }
        }
        if (convo.length) {
            const formatted = convo.map(m => {
                const role = m && m.role === 'assistant' ? 'Assistant' : 'User';
                const content = m && m.content ? String(m.content).replace(/\s+/g, ' ').trim() : '';
                return content ? `${role}: ${content}` : '';
            }).filter(Boolean).join('\n');
            if (formatted) {
                finalMessages.push({ role: 'system', content: `Conversation History:\n${formatted}` });
            }
        }
        let hasKnowledgeSnippets = false;
        if (usedTool === "retrieve_knowledge" && toolResult) {
            try {
                const parsed = typeof toolResult === 'string' ? JSON.parse(toolResult) : toolResult;
                const snippets = parsed && Array.isArray(parsed.snippets) ? parsed.snippets.slice(0, 3) : [];
                if (snippets.length) {
                    finalMessages.push({ role: 'system', content: `Knowledge Snippets:\n${snippets.join('\n\n')}` });
                    hasKnowledgeSnippets = true;
                }
            } catch (e) {}
        }
        if (toolResult && usedTool && usedTool !== "retrieve_knowledge") {
            const toolText = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
            finalMessages.push({ role: 'system', content: `Tool Result:\n${toolText}` });
        }
        finalMessages.push({ role: 'user', content: String(lastUserMessage || '') });
        const finalResp = await callOpenAI(finalMessages, false);
        let out = finalResp && finalResp.success && finalResp.data
            ? (typeof finalResp.data.text === "string" && finalResp.data.text.trim()
                ? finalResp.data.text.trim()
                : (finalResp.data.message && typeof finalResp.data.message.content === "string" ? finalResp.data.message.content.trim() : ""))
            : "";
        if (routerDecision.agent === "knowledge_agent" && usedTool === "retrieve_knowledge" && !hasKnowledgeSnippets) {
            out = "I don’t have that information right now, but I’d be happy to help you with questions about our services or products.";
        }
        if (!out || !out.trim()) {
            out = botBehaviorConfig.fallback_message || "Sorry, I’m having trouble answering right now. Please try again.";
        }
        if (/openai|ai model|language model|chatgpt/i.test(out)) {
            out = "I’m here as the company’s sales and support assistant. I can help with our services, features, pricing, and getting started.";
        }
        const st2 = getUserState(user_id) || state;
        if (st2.hasWelcomed) {
            out = out.replace(welcomeRegex, '$1');
        }
        await sendMessage(socket, out, user_id);
        st2.hasWelcomed = true;
        setUserState(user_id, st2);
        pushConversation(st2, 'bot', out);
    } catch (err) {
        try {
            console.error("AGENT_FATAL_ERROR", err && err.stack ? err.stack : err);
        } catch (e) {}
        if (typeof sendMessage === 'function') {
            await sendMessage(socket, botBehaviorConfig.fallback_message || "Sorry, I’m having trouble answering right now. Please try again.", user_id);
        }
    }
}

module.exports = { processAIResponse, createAIBrain };
