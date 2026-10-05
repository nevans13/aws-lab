// Frontend Lambda function handler for aws-lab chatbot application
// v1.0.0 - 10/1/2026
// nevans13

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");

// Import HTML for the frontend - all content is served from the single index.html file
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

// Create the DynamoDB client
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Create the Lambda client
const lambda = new LambdaClient({});

// Helper function to build JSON response body
const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

// Export the handler function to be invoked by Lambda
exports.handler = async (event) => {
  // Handle requests and return content based on the HTTP method and path
  switch (event.routeKey) {
    // Main root request - return HTML webpage
    case "GET /":
      return { statusCode: 200, headers: { "Content-Type": "text/html" }, body: html };

    // Get account balance for user's account
    case "GET /api/v1/balance": {
      // API Gateway already validated the JWT; read the verified claims and check that the userId exists
      // The user ID is the sub value from the JWT; fail if there is no user ID
      const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
      if (!userId) return json(401, { message: "Unauthorized" });

      // Request the account balance from DynamoDB
      const result = await db.send(new GetCommand({
        TableName: process.env.ACCOUNTS_TABLE,
        Key: { userId },
        ProjectionExpression: "balance"
      }));

      // Return either the balance (if account is found) or an error (if account is not found)
      if (!result.Item) return json(404, { message: "Account not found" });
      return json(200, { balance: result.Item.balance });
    }

    // Submit a chat message to the chatbot
    // Calls the chatbot Lambda to alert it to a new chat message
    case "POST /api/v1/chat": {
      // API Gateway already validated the JWT; read the verified claims and check that the userId exists
      // The user ID is the sub value from the JWT; fail if there is no user ID
      const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
      if (!userId) return json(401, { message: "Unauthorized" });

      // Get the message text
      // Parse the JSON body; a missing or malformed body is a client error
      let body;
      try {
        body = JSON.parse(event.body ?? "");
      } catch {
        return json(400, { message: "Invalid JSON body" });
      }

      // Validate the message before doing anything that costs money or uses the rate limit
      const chatText = typeof body?.message === "string" ? body.message.trim() : ""; // set chatText to the message from the request body if it is a string, or otherwise set it to an empty string
      if (chatText.length < 1 || chatText.length > 2000) {
        return json(400, { message: "Message must be 1 to 2000 characters" });
      }

      // Obtain chat ID and current time
      const chatId = randomUUID();
      const now = Math.floor(Date.now() / 1000); // epoch seconds, from the server clock

      // Post the message: insert into the DynamoDB chats table and then alert the chatbot Lambda
      try {
        await db.send(new PutCommand({
          TableName: process.env.CHATS_TABLE,
          Item: {
            userId, // uses JS shorthand property names (instead of userId: userId)
            chatId, // uses JS shorthand property names (instead of chatId: chatId)
            status: "pending",
            chat: chatText,
            createdAt: now,
            expiresAt: now + 3600 // periodic garbage collection will clear out stale (expired) messages
          },
          ConditionExpression: "attribute_not_exists(chatId)" // never overwrite an existing item
        }));

        // If database insert is successful, call the chatbot Lambda to alert it to the new message
        try {
          await lambda.send(new InvokeCommand({
            FunctionName: process.env.CHATBOT_FUNCTION,
            InvocationType: "Event", // "Event" makes the invocation asynchronous: Lambda queues it and returns immediately, without waiting for the chatbot to finish
            Payload: JSON.stringify({ userId, chatId }) // the unique key for Lambda to reference to get the message
          }));
        } catch (err) {
          // The message was stored but the chatbot was never alerted; mark it failed so the browser client does not poll forever
          console.error("Chatbot invoke failed:", err);
          await db.send(new UpdateCommand({
            TableName: process.env.CHATS_TABLE,
            Key: { chatId, userId },
            UpdateExpression: "SET #status = :failed",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":failed": "failed" }
          }));
          return json(500, { message: "Internal server error" });
        }

        // If database insert is successful, return the chat ID to the client, which it will use to poll for a response
        return json(201, { chatId });
      } catch (err) {
        // If message failed to post, respond with HTTP 500 Internal Server Error
        console.error("Chat write failed:", err);
        return json(500, { message: "Internal server error" });
      }
    }

    // Get the reply to a chat message
    // Attempts to check for a reply to the chat ID in the chats DynamoDB table
    case "GET /api/v1/reply": {
      // API Gateway already validated the JWT; read the verified claims and check that the userId exists
      // The user ID is the sub value from the JWT; fail if there is no user ID
      const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
      if (!userId) return json(401, { message: "Unauthorized" });

      // The chat ID is a query parameter
      const chatId = event.queryStringParameters?.chatId;

      try {
        // Look up by both keys, so a user can only ever read their own chats
        const result = await db.send(new GetCommand({
          TableName: process.env.CHATS_TABLE,
          Key: { chatId, userId },
          ProjectionExpression: "#status, chatReply",
          ExpressionAttributeNames: { "#status": "status" } // "status" is a DynamoDB reserved word, so we use an alias substitution
        }));

        // A chat that does not exist and a chat that belongs to someone else both return 404
        if (!result.Item) return json(404, { message: "Chat not found" });
        return json(200, { status: result.Item.status, chatReply: result.Item.chatReply });
      } catch (err) {
        console.error("Chat read failed:", err);
        return json(500, { message: "Internal server error" });
      }
    }

    // Invalid request path
    // API Gateway already returns a 404 for undefined routes, so realistically this should not run unless there is a route mismatch between API Gateway and Lambda
    default:
      console.error("Unhandled route:", event.routeKey);
      return json(501, { message: "Not Implemented" });
  }
};