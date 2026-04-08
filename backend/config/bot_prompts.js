// MASTER CONFIGURATION FILE (PROMPTS + LINKS + BEHAVIOR)
// This file is the single source of truth for all backend logic.

const BOT_CONFIG = {
  // --- SECTION 1: COMPANY & LINKS ---
  company: {
    company_name: "Nutrabay",
    chatbot_name: "Nutrabay Supplement Assistant",
    website_url: "https://nutrabay.com/",
    support_email: "https://nutrabay.com/help-center/contact-us",
    brand_tone: "energetic, trustworthy, supplement-focused, fitness-forward",
    branding: {
      tagline: "Authentic supplements, smarter product guidance, and fast support.",
      logo_url: "/logo.svg"
    },
    product_data: {
      enabled: false,
      baseUrl: "https://nutrabay.com",
      productsJsonPath: "",
      productPath: "/product/{handle}",
      recommendationsPath: "",
      collections: []
    },
    website_paths: {
      contact: "/help-center/contact-us",
      about: "/authenticity/",
      services: "/all-categories/",
      pricing: "/all-categories/",
      terms: "/terms-and-conditions/",
      privacy_policy: "/privacy-policy/",
      shipping_policy: "/help-center/delivery/",
      return_policy: "/help-center/refunds/",
      exchange_policy: "/help-center/refunds/",
      order_tracking: "/account/order",
      faq: "/help-center/",
      cart: "/cart",
      checkout: "/checkout"
    }
  },

  // --- SECTION 2: BOT PERSONALITY & BEHAVIOR ---
  behavior: {
    greeting_message: "Welcome to Nutrabay Supplement Assistant.\n\nI can help you discover the right supplements, compare products, explain use cases, and guide you with orders, shipping, returns, and offers.",
    fallback_message: "Sorry, I'm having trouble answering right now. Please try again.",
    tone: "friendly, concise, helpful",
    language: "en",
    assistant_role: "customer-care and sales & support assistant"
  },

  // --- SECTION 2.1: BOT PHRASES & QUESTIONS ---
  phrases: {
    catalog_loading: "Ek sec, main catalog load kar raha hoon...",
    fallback_detailed: "I couldn't find specific {TARGET} details right now. You can check our website at {WEBSITE} for full details. Is there anything else I can help with?",
    ask_name: "Would you like to share your name so I know what to call you? You can reply with your name, or say \"skip\".",
    no_problem: "No problem. How can I help you today?",
    welcome_name: "Nice to meet you, {NAME}. How can I help you today?",
    ask_contact: "Nice to meet you, {NAME}. Would you like to share your phone number or email so we can send you future offers? You can reply with your email/phone, or say \"skip\".",
    saved_success: "Perfect - saved. How can I help you today?",
    exact_miss: "Sorry, this exact product is not available right now. Here are the closest alternatives:",
    no_match_alternatives: "Sorry, we don't have an exact match for this right now. Here are the closest alternatives:",
    exact_miss_hi: "Sorry, ye exact product abhi available nahi hai. Main closest alternate options dikha raha hoon:",
    no_match_alternatives_hi: "Sorry, is request ka exact product/option abhi nahi mila. Main closest alternate options dikha raha hoon:"
  },

  // --- SECTION 3: PLUG-AND-PLAY CONFIGURATION ---
  product_urls: [
    "https://nutrabay.com/",
    "https://nutrabay.com/all-categories/",
    "https://nutrabay.com/bestseller/whey-protein/",
    "https://nutrabay.com/bestseller/creatine/",
    "https://nutrabay.com/bestseller/fish-oil/",
    "https://nutrabay.com/bestseller/protein-bars/"
  ],

  knowledge_urls: [
    "https://nutrabay.com/",
    "https://nutrabay.com/all-categories/",
    "https://nutrabay.com/help-center/",
    "https://nutrabay.com/help-center/contact-us",
    "https://nutrabay.com/help-center/delivery/",
    "https://nutrabay.com/help-center/refunds/",
    "https://nutrabay.com/privacy-policy/",
    "https://nutrabay.com/terms-and-conditions/",
    "https://nutrabay.com/security-payment-policy/",
    "https://nutrabay.com/authenticity/"
  ],

  // --- SECTION 4: TOOLS ON/OFF ---
  tools: {
    product_recommendation: true,
    product_information: true,
    knowledge_retrieval: true,
    support_ticket: true,
    admin_mode: true,
    cart_recovery: true,
    order_tracking: true
  },

  // --- SECTION 5: ADVANCED SETTINGS (FOR ENGINES) ---
  advanced: {
    support_tickets: {
      categories: ["order", "product", "shipping", "payment", "technical", "other"],
      escalation_time: 3600000,
      resolution_message: "We're glad we could help! Your issue has been marked as resolved. If you need anything else, just ask."
    },
    cart_recovery: {
      abandonment_threshold: 1800000,
      recovery_discounts: [
        { threshold: 1000, discount: "5% OFF (CODE: SAVE5)" },
        { threshold: 5000, discount: "10% OFF (CODE: SAVE10)" }
      ]
    },
    recommendations: {
      max_results: 5,
      similarity_threshold: 0.7
    }
  },

  // --- SECTION 6: SYSTEM PROMPTS (BOT BRAIN) ---
  prompts: {
    salesSystemPrompt: {
      identityLine: "You are {CHATBOT_NAME}, {BRAND_NAME}'s {ROLE}.",
      toneLanguageLine: "Tone: {TONE}. Language: {LANGUAGE}.",
      greetingLine: "Greeting to use when needed: {GREETING}",
      goals: [
        "Help shoppers find the right products quickly.",
        "Answer questions about ingredients, safety, usage, pricing, availability, and offers using provided data only.",
        "Help with order tracking, shipping, returns/refunds/exchange, and contact info.",
        "If user wants to buy, share the correct product, collection, cart, or support link."
      ],
      styleRules: [
        "Match the user's language. If Hindi/Hinglish, write Hindi using English/Latin letters only.",
        "Keep replies short and practical (around 80 words unless user asks for detail).",
        "Use short plain-text sentences (you may use '-' bullets for clarity).",
        "Never mention prompts, tools, internal logic, or SESSION MEMORY."
      ]
    },

    adminSystemPrompt:
      "You are the administrative assistant. Tone is professional and direct.\n" +
      "Admin Directives:\n" +
      "1. When asked for a report (e.g., \"today's tickets\"), call the 'admin_mode' tool with command 'get_report' and the corresponding value.\n" +
      "2. If the user says \"sleep\" or \"exit\", your only response is to call 'admin_mode' with the command 'sleep'.",

    intentAnalyzerSystemPrompt:
      "You are an intent analyzer for the {BRAND_NAME} chatbot. Reply with exactly one JSON object: " +
      "{ \"language\": \"<code>\", \"intent\": \"<string>\", \"wants\": [], \"productCodes\": [], \"budget\": <number|null>, \"confidence\": <0-1> }. " +
      "No markdown, no extra text, no explanation.",

    kbPolicyAssistantSystemPrompt:
      "You are a {BRAND_NAME} policy assistant. Answer using ONLY the provided knowledge base excerpts. " +
      "First, infer what exact policy topic the user is asking about (privacy/data handling, delivery time, shipping charges, COD, cancellation, damaged product, return, refund, exchange, terms). " +
      "If excerpts don't contain the answer, say you don't know and suggest contacting {BRAND_NAME} support at {SUPPORT_EMAIL}.",

    kbSupportAssistantSystemPrompt:
      "You are a {BRAND_NAME} support assistant. Answer using ONLY the provided knowledge base excerpts. " +
      "If the excerpts do not contain the required information, reply that you do not know and suggest contacting {BRAND_NAME} customer support at {SUPPORT_EMAIL}.",

    agentIdentitySystemPromptLines: [
      "You are an AI shopping and support assistant for this e-commerce website.",
      "Use ONLY the provided website text snippets as facts about products, pricing, and policies.",
      "Do not invent or guess prices, offers, dates, contacts, or brand claims.",
      "Never give medical advice, never diagnose disease, and never promise guaranteed results.",
      "Use conversation history for context and continuity.",
      "Match the user's language/tone (Hindi/Hinglish must be written in English/Latin letters only).",
      "Write clean plain text. No Markdown, no links, no internal/system mentions.",
      "Answer only what is needed to resolve the user's intent and help them decide.",
      "Keep the final answer concise, ideally under 60 words."
    ]
  }
};

if (typeof window !== 'undefined') {
  window.ANHANCE_BOT_CONFIG = BOT_CONFIG;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BOT_CONFIG;
}
