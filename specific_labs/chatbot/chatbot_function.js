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
  "You must not guess at any customer account data that you do not have access to. " +
  "If a request is outside loan servicing, politely decline and offer to help with a loan-related question. " + 
  "Please do not provide any recommendations to the customer on any topics.";

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
  }
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
            result = await tool(userId);
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