const botConfig = require('../config/bot_prompts');
const botPrompts = botConfig.prompts;
const toolsConfig = botConfig.tools;
const companyConfig = botConfig.company;
const brandLabel = companyConfig.company_name || companyConfig.chatbot_name || 'the company';

const tools = [
// yeh unified tool Anhance AI ke plans/services ko UI cards me dikhata hai
    {
        type: "function",
        function: {
            name: "show_products",
            description: `Show ${brandLabel} product cards for browsing, generic catalog requests, recommendations, or similar products. Use this for new product discovery, not for answering details about an already shown product.`,
            parameters: {
                type: "object",
                properties: {
                    search_scope: {
                        type: "string",
                        enum: ["new", "refine", "continue"],
                        description: "Scope you have already decided: new intent, refinement of current intent, or pure continuation."
                    },
                    mode: {
                        type: "string",
                        enum: ["single", "list", "compare"],
                        description: "High-level view type decided by you: single highlight, list browsing, or comparison."
                    },
                    query_type: {
                        type: "string",
                        enum: ["search", "similar", "upsell", "cross_sell"],
                        description: "Execution path: search (general), similar (related features), upsell (higher tier), or cross_sell (add-ons)."
                    },
                    base_product_id: {
                        type: "string",
                        description: "Optional context id from prior cards, if available."
                    },
                    search_text: {
                        type: "string",
                        description: "Natural-language shopping query, product need, or generic browse request."
                    },
                    preferences: {
                        type: "object",
                        description: "Structured copy of key shopping preferences you have already inferred.",
                        properties: {
                            use_case: { type: "string" },
                            budget_min: { type: "number" },
                            budget_max: { type: "number" },
                            channels: { type: "string" },
                            team_size: { type: "number" },
                            industry: { type: "string" }
                        }
                    },
                    limit: {
                        type: "integer",
                        enum: [1, 2, 3, 5],
                        description: "How many cards to show when possible."
                    }
                },
                required: ["search_scope", "mode", "query_type"]
            }
        }
    },
// yeh tool store info/policies aur simple coupon maths waale general sawaalon ka answer deta hai
    {
        type: "function",
        function: {
            name: "answer_general_question",
            description: "Answer store info/policy questions and simple coupon math.",
            parameters: { type: "object", properties: { userQuery: { type: "string" } }, required: ["userQuery"] }
        }
    },
    {
        type: "function",
        function: {
            name: "retrieve_knowledge",
            description: "Retrieve relevant website knowledge snippets from Supabase for the given query.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "User question or topic for knowledge retrieval." },
                    max_snippets: { type: "integer", description: "Optional cap on snippets to return." },
                    max_chars: { type: "integer", description: "Optional max characters per snippet." }
                },
                required: ["query"]
            }
        }
    },
// yeh tool website se verified contact/WhatsApp numbers nikal kar user ko deta hai
    {
        type: "function",
        function: {
            name: "get_contact_info",
            description: `Fetch ${brandLabel} verified contact and WhatsApp numbers from the website and reply with them.`,
            parameters: {
                type: "object",
                properties: {
                    userQuery: { type: "string", description: "User's original query text asking for phone/WhatsApp/contact number." }
                },
                required: ["userQuery"]
            }
        }
    },
// yeh tool specifically privacy policy / data handling ke sawalon ke jawab ke liye hai
    {
        type: "function",
        function: {
            name: "get_privacy_policy_info",
            description: `Answer questions about ${brandLabel} privacy policy using live website text.`,
            parameters: {
                type: "object",
                properties: {
                    userQuery: { type: "string", description: "User's original privacy/data question." }
                },
                required: ["userQuery"]
            }
        }
    },
// yeh tool user ke request ke hisaab se sahi Anhance links (product/policy/collection/cart) bhejta hai
    {
        type: "function",
        function: {
            name: "get_links",
            description: `Provide verified ${brandLabel} links (product page/buying link, policy pages, collections, cart/checkout) based on the user's request and current session context.`,
            parameters: {
                type: "object",
                properties: {
                    userQuery: { type: "string", description: "User's original link request text." },
                    selectionText: { type: "string", description: "Optional product reference text (e.g., first/second/code/SKU/name)." },
                    selectionIndex: { type: "integer", description: "Optional index into the last displayed products list." },
                    productId: { type: "string", description: "Optional selected product id from the last displayed products list." }
                },
                required: ["userQuery"]
            }
        }
    },
// yeh tool support issue ko ticket banane se pehle knowledge base se solve karne ki koshish karta hai
    {
        type: "function",
        function: {
            name: "attempt_to_solve_issue",
            description: "Try to solve a user issue using knowledge base.",
            parameters: {
                type: "object",
                properties: {
                    issueDescription: {
                        type: "string"
                    }
                },
                required: ["issueDescription"]
            }
        }
    },
// yeh tool unresolved problem ke liye Supabase me proper support ticket record create karta hai
    {
        type: "function",
        function: {
            name: "raise_support_ticket",
            description: "Create support ticket for an unresolved issue.",
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "User's name, if available."
                    },
                    email: {
                        type: "string",
                        description: "User's email, if available."
                    },
                    issue: {
                        type: "string",
                        description: "Short summary of the issue."
                    }
                },
                required: ["issue"]
            }
        }
    },
// yeh tool password-protected admin dashboard ke sare commands aur reports handle karta hai
    {
        type: "function",
        function: {
            name: "admin_mode",
            description: "Handles all administrative tasks.",
            parameters: { type: "object", properties: { command: { type: "string" }, value: { type: "string" } }, required: ["command"] }
        }
    },
// yeh tool already shown cards me se ek selected plan/service ka detail batata hai
    {
        type: "function",
        function: {
            name: "describe_selected_product",
            description: `Provide details for one specific ${brandLabel} product already shown to the user. Use this for follow-up questions like this product, first one, second one, or product name/code references.`,
            parameters: {
                type: "object",
                properties: {
                    selectionText: {
                        type: "string",
                        description: "User text that identifies the shown product (e.g., this product, first one, SKU, product name)."
                    },
                    selectionIndex: {
                        type: "integer",
                        description: "Index into the last displayed products list."
                    },
                    productId: {
                        type: "string",
                        description: "Optional selected product id from the last displayed list."
                    },
                    userQuestion: {
                        type: "string",
                        description: "Full user question about this product (description, price, use, ingredients, benefits, specs)."
                    }
                }
            }
        }
    },
// yeh tool recent ya hinted do plans/services ko compare karke text me difference/choice explain karta hai
    {
        type: "function",
        function: {
            name: "compare_recent_products",
            description: "Compare two plans/services using recent context or provided names.",
            parameters: {
                type: "object",
                properties: {
                    userQuestion: {
                        type: "string",
                        description: "User comparison question/context."
                    }
                },
                required: ["userQuestion"]
            }
        }
    },
// yeh tool full smart flow se do best plans/services choose karke cards + comparison + recommendation deta hai
    {
        type: "function",
        function: {
            name: "smart_compare_products",
            description: "Show two plan/service cards and a comparison with recommendation.",
            parameters: {
                type: "object",
                properties: {
                    userQuestion: {
                        type: "string",
                        description: "User comparison question/context."
                    }
                },
                required: ["userQuestion"]
            }
        }
    }
];

const toolCategoryMap = {
    show_products: 'product_recommendation',
    compare_recent_products: 'product_recommendation',
    smart_compare_products: 'product_recommendation',
    describe_selected_product: 'product_information',
    retrieve_knowledge: 'knowledge_retrieval',
    answer_general_question: 'knowledge_retrieval',
    get_contact_info: 'knowledge_retrieval',
    get_privacy_policy_info: 'knowledge_retrieval',
    get_links: 'knowledge_retrieval',
    attempt_to_solve_issue: 'support_ticket',
    raise_support_ticket: 'support_ticket',
    admin_mode: 'admin_mode'
};

const filteredTools = tools.filter((tool) => {
    const name = tool && tool.function ? tool.function.name : null;
    if (!name) return false;
    const bucket = toolCategoryMap[name];
    if (!bucket) return true;
    const flag = toolsConfig && typeof toolsConfig[bucket] === 'boolean' ? toolsConfig[bucket] : true;
    return !!flag;
});

module.exports = filteredTools;
