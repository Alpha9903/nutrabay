// yeh function pehle knowledge base use karke user ki issue ko auto-resolve karne ki koshish karta hai
async function attemptToSolveIssue(args) {
    const { issueDescription, callOpenAI, queryKnowledgeBase } = args;
    let kbText = "";
    try {
        if (typeof queryKnowledgeBase === "function") {
            const kb = await queryKnowledgeBase(issueDescription);
            if (kb && typeof kb.content === "string" && kb.content.trim()) {
                kbText = kb.content.trim();
            } else if (kb && Array.isArray(kb.matches) && kb.matches.length) {
                kbText = kb.matches.map(t => String(t || "").trim()).filter(Boolean).join("\n\n");
            }
        }
    } catch (e) {
        kbText = "";
    }
    const fallbackKnowledgeBase = [
        "For shipping delays, please check your tracking number. Delays can sometimes occur due to weather or logistical issues.",
        "If you can't log in, try resetting your password using the 'Forgot Password' link on the login page."
    ];
    const prompt = `Based on the provided knowledge base, find a concise solution for the following user issue. If no direct solution is found, provide general advice.
    Knowledge Base (Preferred): ${kbText || "(empty)"}
    Knowledge Base (Fallback): ${fallbackKnowledgeBase.join('\n')}
    User Issue: "${issueDescription}"
    Detect the language of the user's issue (for example Hindi, English, or Hinglish) and respond in that same language or mix. When the detected language is Hindi or Hinglish, respond in Hinglish: Hindi written using English/Latin alphabets only, without Devanagari or Hindi script.
    Write the solution in clean, plain text with short sentences, without any Markdown formatting, bullet symbols, or markdown-style links.
    Solution:`;
    const messages = [{ role: 'system', content: prompt }];
    const response = await callOpenAI(messages);
    if (response.success) {
        return JSON.stringify({ success: true, solution: response.data.message.content });
    }
    return JSON.stringify({ success: false, error: "Could not find a solution at this time." });
}

// yeh helper given user ke latest chat_log ka id nikalta hai taaki ticket se link ho sake
async function findLatestChatLogId({ supabase, botId, userDbId }) {
    if (!supabase || !botId || !userDbId) return null;
    const candidates = [
        { userColumn: 'user_id', orderColumn: 'created_at' },
        { userColumn: 'chat_user_id', orderColumn: 'timestamp' },
        { userColumn: 'user_id', orderColumn: 'timestamp' },
        { userColumn: 'chat_user_id', orderColumn: 'created_at' }
    ];
    for (const c of candidates) {
        try {
            const { data: logs, error } = await supabase
                .from('chat_logs')
                .select('id')
                .eq(c.userColumn, userDbId)
                .eq('bot_id', botId)
                .order(c.orderColumn, { ascending: false })
                .limit(1);
            if (!error && Array.isArray(logs) && logs.length > 0 && logs[0].id != null) {
                return logs[0].id;
            }
        } catch (e) {
        }
    }
    return null;
}

// yeh function realtime chat (socket) context se ek support ticket row create karta hai
async function raiseSupportTicket(args) {
    const { name, email, issue, socket, supabase, getBotId } = args;
    try {
        if (!supabase || !getBotId()) {
            console.error("Support ticket creation is not configured: Supabase or BOT_ID is missing.");
            return JSON.stringify({ success: false, error: "Support tickets are not configured." });
        }
        if (!socket || !socket.__dbUserId) {
            console.error("Support ticket creation failed: missing database user binding on socket.");
            return JSON.stringify({ success: false, error: "Support tickets are not configured." });
        }
        const ticketId = `TKT-${Date.now().toString().slice(-6)}`;
        const nowIso = new Date().toISOString();
        const botId = getBotId();
        const subjectText = String(issue || '').trim().slice(0, 120) || 'Support request';
        const chatLogId = await findLatestChatLogId({ supabase, botId, userDbId: socket.__dbUserId });
        const ticketRecord = {
            user_id: socket.__dbUserId,
            bot_id: botId,
            status: 'open',
            priority: 'medium',
            ticket_id: ticketId,
            subject: subjectText,
            name,
            email,
            issue,
            created_at: nowIso
        };
        if (chatLogId != null) {
            ticketRecord.chat_id = chatLogId;
        }
        const { error } = await supabase
            .from('tickets')
            .insert(ticketRecord);
        if (error) {
            console.error("Error inserting support ticket:", error.message || error);
            return JSON.stringify({ success: false, error: "Failed to create the support ticket." });
        }
        return JSON.stringify({ success: true, ticketId, name });
    } catch (e) {
        console.error("Unexpected error while creating support ticket:", e.message || e);
        return JSON.stringify({ success: false, error: "Failed to create the support ticket." });
    }
}

// yeh core helper kisi bhi external channel (jaise WhatsApp/webhook) se support ticket bana deta hai
async function createSupportTicketCore(args) {
    const { user_id, message, channel, supabase, getBotId } = args;
    try {
        if (!supabase || !getBotId() || !user_id) {
            return { success: true };
        }
        const botId = getBotId();
        const { data: userRows, error: userError } = await supabase
            .from('users')
            .select('id, platform_user_id')
            .eq('platform_user_id', user_id)
            .eq('bot_id', botId)
            .limit(1);
        if (userError || !Array.isArray(userRows) || userRows.length === 0) {
            return { success: true };
        }
        const dbUser = userRows[0];
        const chatLogId = await findLatestChatLogId({ supabase, botId, userDbId: dbUser.id });
        const ticketId = `TKT-${Date.now().toString().slice(-6)}`;
        const nowIso = new Date().toISOString();
        const subjectText = String(message || '').trim().slice(0, 120) || 'Support request';
        const ticketRecord = {
            user_id: dbUser.id,
            bot_id: botId,
            status: 'open',
            priority: 'medium',
            ticket_id: ticketId,
            subject: subjectText,
            channel,
            message: String(message || ''),
            created_at: nowIso
        };
        if (chatLogId != null) {
            ticketRecord.chat_id = chatLogId;
        }
        const { error } = await supabase
            .from('tickets')
            .insert(ticketRecord);
        if (error) {
            console.error("❌ Error creating support ticket:", error.message || error);
            return { success: false, error: "Ticket creation failed." };
        }
        return { success: true, ticketId };
    } catch (e) {
        console.error("❌ Error creating support ticket:", e.message);
        return { success: false, error: "Ticket creation failed." };
    }
}

// yeh helper aaj ke din me kitne tickets raise hue uska count return karta hai
async function getTicketsReportToday(args) {
    const { supabase, botId } = args;
    if (!supabase || !botId) {
        return { success: false, error: "Tickets data store not configured." };
    }
    try {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        const { count, error } = await supabase
            .from('tickets')
            .select('*', { count: 'exact', head: true })
            .eq('bot_id', botId)
            .gte('created_at', start.toISOString())
            .lt('created_at', end.toISOString());
        if (error) {
            return { success: false, error: `Failed to fetch report: ${error.message || error}` };
        }
        const ticketsToday = typeof count === 'number' ? count : 0;
        return { success: true, ticketsToday };
    } catch (e) {
        return { success: false, error: `Failed to fetch report: ${e.message}` };
    }
}

module.exports = {
    attemptToSolveIssue,
    raiseSupportTicket,
    createSupportTicketCore,
    getTicketsReportToday
};
