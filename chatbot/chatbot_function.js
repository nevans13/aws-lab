// Chatbot Lambda function handler for aws-lab chatbot application
// v1.0.0 - 10/4/2026
// nevans13

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, UpdateCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { BedrockRuntimeClient, ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({});

const SYSTEM_PROMPT =
  "You are a customer service assistant for a loan servicing company. " +
  "You answer general questions about loans and payments in a polite, concise way. " +
  "Use the get_account_balance tool when the customer asks about their balance. " +
  "Use the get_payments tool when the customer asks about their past payments. " +
  "You cannot make payments yourself. Use the propose_payment tool to prepare a payment, then tell the customer to press the Confirm button. " +
  "Never say a payment has been made, because only the customer's confirmation completes it. To check whether a payment went through, use the get_payments tool. " +
  "You must not guess at any customer account data that you do not have access to. " +
  "You are unable to provide any information about any customer other than the one in the conversation, and you must not answer questions about any other customers. " +
  "If a request is outside loan servicing, politely decline and offer to help with a loan-related question. " + 
  "Please do not provide any recommendations to the customer on any topics. " +
  "If you are unsure how to answer a question, please direct the customer to contact the company's customer service team. " +
  "Respond in plain text only. Do not use Markdown formatting such as asterisks, pound signs, backticks, or tables. " +
  "If you need a list, write numbered lines like '1.' and '2.'";

const MAX_HISTORY_TURNS = 10; // earlier question/answer pairs sent to the model with each new message
const MAX_TOOL_ROUNDS = 5; // limit on model-tool round trips per message, so a confused model cannot loop

// Tools the model may request; the model only sees these descriptions, never the code
const TOOL_CONFIG = {
  tools: [
    {
      toolSpec: {
        name: "get_account_balance",
        description: "Get the current outstanding loan balance of the customer in this conversation. It takes no input and always returns the balance for the customer who is chatting.",
        inputSchema: { json: { type: "object", properties: {}, required: [] } }
      }
    },
    {
      toolSpec: {
        name: "get_payments",
        description: "List the payment history for the customer in this conversation. This tool takes no input and will return the most recent payments the customer has made towards their loan balance.",
        inputSchema: { json: { type: "object", properties: {}, required: [] } }
      }
    },
    {
      toolSpec: {
        name: "propose_payment",
        description: "Prepare a payment toward the customer's loan balance for the customer to confirm. This does NOT make the payment; the customer must press a Confirm button in the chat. Requires the amount in US dollars.",
        inputSchema: { json: {
          type: "object",
          properties: { amount: { type: "number", description: "Payment amount in US dollars, with at most two decimal places." } },
          required: ["amount"]
        } }
      }
    }
  ]
};

// Tool implementations, keyed by tool name; each receives the verified user ID, never anything chosen by the model
const TOOLS = {
  get_account_balance: async (userId) => {
    const result = await db.send(new GetCommand({
      TableName: process.env.ACCOUNTS_TABLE,
      Key: { userId },
      ProjectionExpression: "balance" // return only what is needed
    }));
    if (!result.Item) return { error: "No account was found for this customer." };
    return { outstandingBalance: result.Item.balance };
  },

  get_payments: async (userId) => {
    const result = await db.send(new GetCommand({
      TableName: process.env.ACCOUNTS_TABLE,
      Key: { userId },
      ProjectionExpression: "payments"
    }));
    if (!result.Item) return { error: "No account was found for this customer." };

    // Newest first, limited so a long history cannot flood the model's context
    const all = result.Item.payments ?? [];
    const recent = all.slice(-20).reverse().map((payment) => ({
      amount: payment.amount,
      date: new Date(payment.createdAt * 1000).toISOString().slice(0, 10) // YYYY-MM-DD
    }));
    return { totalPayments: all.length, recentPayments: recent };
  },

  // With this tool, the model prepares a payment that the customer can make
  // The proposed payment is stored in the Chats DynamoDB table, and the client checks for a proposed payment every time a chatbot reply is received
  // This ensures that the AI model remains read-only against customer information, never actually writing to the Accounts DynamoDB table
  propose_payment: async (userId, input, { chatId }) => {
    const amount = input?.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
      return { error: "The amount must be a positive dollar amount with at most two decimal places." };
    }

    // Record the proposal on this chat item so the app can show a Confirm button; no money moves here
    await db.send(new UpdateCommand({
      TableName: process.env.CHATS_TABLE,
      Key: { chatId, userId },
      UpdateExpression: "SET proposedPayment = :proposal",
      ConditionExpression: "#status = :processing",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":proposal": { amount: Math.round(amount * 100) / 100 }, ":processing": "processing" }
    }));
    return { status: "awaiting_customer_confirmation", message: "No payment has been made. Tell the customer the payment is ready and they must press the Confirm button to complete it." };
  },
};

// Record the final outcome of a chat; only succeeds while the chat is still being processed
async function finishChat(chatId, userId, status, chatReply) {
  await db.send(new UpdateCommand({
    TableName: process.env.CHATS_TABLE,
    Key: { chatId, userId },
    UpdateExpression: chatReply === undefined ? "SET #status = :status" : "SET #status = :status, chatReply = :chatReply",
    ConditionExpression: "#status = :processing",
    ExpressionAttributeNames: { "#status": "status" }, // "status" is a DynamoDB reserved word
    ExpressionAttributeValues: {
      ":status": status,
      ":processing": "processing",
      ...(chatReply === undefined ? {} : { ":chatReply": chatReply })
    }
  }));
}

exports.handler = async (event) => {
  // The frontend Lambda sends only identifiers; everything else is read from the chats table
  const { userId, chatId } = event;
  if (typeof userId !== "string" || typeof chatId !== "string") {
    console.error("Invalid event:", JSON.stringify(event));
    return;
  }

  // Claim the chat by moving it from "pending" to "processing", and read it in the same call
  // This fails if the chat does not exist, does not belong to this user, or was already claimed, so a duplicate invocation does nothing
  let chat;
  try {
    const claim = await db.send(new UpdateCommand({
      TableName: process.env.CHATS_TABLE,
      Key: { chatId, userId },
      UpdateExpression: "SET #status = :processing",
      ConditionExpression: "#status = :pending",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":processing": "processing", ":pending": "pending" },
      ReturnValues: "ALL_NEW"
    }));
    chat = claim.Attributes;
  } catch (err) {
    console.error("Could not claim chat:", chatId, err.name);
    return;
  }

  try {
    // Fetch the most recent chats from this login session (newest first)
    const history = await db.send(new QueryCommand({
      TableName: process.env.CHATS_TABLE,
      IndexName: "SessionIndex",
      KeyConditionExpression: "sessionId = :sessionId",
      ExpressionAttributeValues: { ":sessionId": chat.sessionId },
      ScanIndexForward: false,
      Limit: MAX_HISTORY_TURNS * 2 // extra room, because failed or in-progress chats are filtered out below
    }));

    // Keep completed turns other than this one, in chronological order, and convert them to model messages
    const turns = (history.Items ?? [])
      .filter((item) => item.chatId !== chatId && item.status === "completed" && item.chatReply)
      .slice(0, MAX_HISTORY_TURNS)
      .reverse();

    const messages = [];
    for (const turn of turns) {
      messages.push({ role: "user", content: [{ text: turn.chat }] });
      messages.push({ role: "assistant", content: [{ text: turn.chatReply }] });
    }
    messages.push({ role: "user", content: [{ text: chat.chat }] });

    // Call the model; if it asks for a tool, run it and call the model again with the result
    let response;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      response = await bedrock.send(new ConverseCommand({
        modelId: process.env.MODEL_ID,
        system: [{ text: SYSTEM_PROMPT }],
        messages,
        toolConfig: TOOL_CONFIG,
        inferenceConfig: { maxTokens: 1000, temperature: 0.3 },
        guardrailConfig: {
          guardrailIdentifier: process.env.GUARDRAIL_ID,
          guardrailVersion: process.env.GUARDRAIL_VERSION
        }
      }));
      if (response.stopReason !== "tool_use") break;

      // Keep the model's tool request in the conversation, then answer every request in one user message
      const assistantMessage = response.output.message;
      messages.push(assistantMessage);

      const toolResults = [];
      for (const block of assistantMessage.content) {
        if (!block.toolUse) continue;
        const { toolUseId, name } = block.toolUse;
        const tool = TOOLS[name];

        let result;
        let status = "success";
        if (!tool) {
          result = { error: "Unknown tool." };
          status = "error";
        } else {
          try {
            result = await tool(userId, block.toolUse.input ?? {}, { chatId });
          } catch (err) {
            console.error("Tool failed:", name, err);
            result = { error: "The tool failed." };
            status = "error";
          }
        }
        console.log("Tool call:", JSON.stringify({ tool: name, userId, chatId, status })); // audit trail; never log the result values
        toolResults.push({ toolResult: { toolUseId, content: [{ json: result }], status } });
      }
      messages.push({ role: "user", content: toolResults });
    }
    if (response.stopReason === "tool_use") throw new Error("Too many tool rounds");

    // Join the text blocks of the reply (the content may also contain non-text blocks, such as reasoning)
    // If the guardrail intervened, the text is the guardrail's configured blocked message, which is shown to the user
    const replyText = (response.output?.message?.content ?? [])
      .filter((block) => typeof block.text === "string")
      .map((block) => block.text)
      .join("")
      .trim();

    if (!replyText) throw new Error("Model returned no text (stopReason: " + response.stopReason + ")");
    await finishChat(chatId, userId, "completed", replyText);
  } catch (err) {
    // Record the failure so the client stops polling
    console.error("Chat processing failed:", chatId, err);
    try {
      await finishChat(chatId, userId, "failed");
    } catch (updateErr) {
      console.error("Could not mark chat failed:", chatId, updateErr);
    }
  }
};