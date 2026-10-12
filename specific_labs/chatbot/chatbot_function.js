// Chatbot Lambda function handler for aws-lab chatbot application
// v1.0.0 - 10/4/2026
// nevans13

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { BedrockRuntimeClient, ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({});

const SYSTEM_PROMPT =
  "You are a customer service assistant for a loan servicing company. " +
  "You answer general questions about loans and payments in a polite, concise way. " +
  "You do not have access to any customer's account data and you must not guess it. " +
  "If a request is outside loan servicing, politely decline and offer to help with a loan-related question.";

const MAX_HISTORY_TURNS = 10; // earlier question/answer pairs sent to the model with each new message

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

    // Call the model with the guardrail attached
    const response = await bedrock.send(new ConverseCommand({
      modelId: process.env.MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages,
      inferenceConfig: { maxTokens: 1000, temperature: 0.3 },
      guardrailConfig: {
        guardrailIdentifier: process.env.GUARDRAIL_ID,
        guardrailVersion: process.env.GUARDRAIL_VERSION
      }
    }));

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