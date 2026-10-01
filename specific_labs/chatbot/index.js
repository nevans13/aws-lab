// Frontend Lambda function handler for aws-lab chatbot application
// v1.0.0 - 10/1/2026
// nevans13

const fs = require("fs");
const path = require("path");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");

// Import HTML for the frontend - all content is served from the single index.html file
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

// Create the DynamoDB client
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Helper function to build JSON response body
const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  // Handle requests and return content based on the HTTP method and path
  switch (event.routeKey) {
    // Main root request - return HTML webpage
    case "GET /":
      return { statusCode: 200, headers: { "Content-Type": "text/html" }, body: html };

    // Get account balance for user's account
    case "GET /api/v1/balance": {
      // API Gateway already validated the JWT; read the verified claims
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

    // Invalid request path
    // API Gateway already returns a 404 for undefined routes, so realistically this should not run unless there is a route mismatch between API Gateway and Lambda
    default:
      console.error("Unhandled route:", event.routeKey);
      return json(501, { message: "Not Implemented" });
  }
};