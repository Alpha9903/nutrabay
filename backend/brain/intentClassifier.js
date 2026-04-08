const botConfig = require('../config/bot_prompts');
const companyConfig = botConfig.company;

// yeh factory function OpenAI client se intent classifier banata hai
function createIntentClassifier(deps) {
    const openai = deps && deps.openai ? deps.openai : null;
    const model = deps && deps.model ? deps.model : process.env.OPENAI_MODEL || "gpt-5-nano";

    if (!openai) {
        throw new Error("intentClassifier requires an existing OpenAI client instance.");
    }

    // yeh function user message + history se exact intent nikalta hai
    async function classifyIntent(args) {
        const userMessage = args && typeof args.userMessage === "string" ? args.userMessage : "";
        const conversationHistory = Array.isArray(args && args.conversationHistory) ? args.conversationHistory : [];

        const allowedIntents = new Set([
            "product_search",
            "product_compare",
            "product_followup",
            "support_issue",
            "general_chat"
        ]);

        const assistantName = companyConfig.chatbot_name || companyConfig.company_name || "company assistant";
        const baseSystem = [
            `You are an intent classifier for the ${assistantName} shopping and support assistant.`,
            "Pick exactly one intent for the latest user message.",
            "Allowed: product_search, product_compare, product_followup, support_issue, general_chat.",
            "Product browsing/search or code/SKU/id => product_search.",
            "Comparing options or 'which is better' => product_compare.",
            "Refers to previously shown items (first/second/similar/like that) => product_followup.",
            "Problem/complaint/issue => support_issue.",
            "Policies/info (returns/shipping/tracking/payment/warranty/contact/privacy/about/services/pricing/company) => support_issue.",
            "Output ONLY JSON: { \"intent\": \"...\" }"
        ].join("\n");

        const messages = [];
        messages.push({ role: "system", content: baseSystem });
        const historyTail = conversationHistory.slice(-3);
        historyTail.forEach(m => {
            if (!m || !m.content) return;
            const role = m.role === "assistant" || m.role === "user" ? m.role : "user";
            messages.push({ role, content: String(m.content || "").slice(0, 260) });
        });
        messages.push({ role: "user", content: String(userMessage || "").slice(0, 260) });

        const completion = await openai.chat.completions.create({
            model,
            temperature: 0,
            response_format: { type: "json_object" },
            messages,
            max_completion_tokens: 2000
        });

        try {
            const usage = completion && completion.usage ? completion.usage : {};
            const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
            const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
            const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : null;
            console.log("LLM_CALL_METRICS", {
                source: "intent_classifier",
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
        const msg = choice.message || {};
        let parsed = null;
        try {
            if (typeof msg.content === "string") {
                parsed = JSON.parse(msg.content);
            } else if (msg.content && typeof msg.content === "object") {
                parsed = msg.content;
            }
        } catch {
            parsed = null;
        }
        const rawIntent = parsed && typeof parsed.intent === "string" ? parsed.intent : "general_chat";
        const intent = allowedIntents.has(rawIntent) ? rawIntent : "general_chat";
        return { intent };
    }

    return {
        classifyIntent
    };
}

module.exports = createIntentClassifier;
