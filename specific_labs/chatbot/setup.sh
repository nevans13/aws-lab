#!/bin/bash

# This script is for the aws-lab chatbot application and should be run in the repository, before any other commands
# Requirements: authenticated AWS CLI, zip package

# Force script to exit if a command fails or a variable is unset
set -eu

# Set locale to POSIX
export LC_ALL=C

# Create the stack and wait for completion
echo Creating CloudFormation stack...
aws cloudformation create-stack --region us-east-2 --stack-name aws-lab-chatbot --capabilities CAPABILITY_IAM --template-body file://aws-lab/specific_labs/chatbot.yaml --output off
aws cloudformation wait stack-create-complete --stack-name aws-lab-chatbot --region us-east-2

# Insert the Cognito User Pool App Client ID created in AWS into the frontend HTML
echo Inserting Cognito User Pool App Client ID into frontend HTML...
COGNITO_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name aws-lab-chatbot --region us-east-2 --query "Stacks[0].Outputs[?OutputKey=='CognitoClientId'].OutputValue" --output text)
sed -i "s/YOUR_APP_CLIENT_ID/$COGNITO_CLIENT_ID/" aws-lab/specific_labs/chatbot/index.html

# Bundle frontend Lambda files at the zip root (with "-j")
echo Bundling frontend Lambda code...
zip -j aws-lab/specific_labs/frontend.zip aws-lab/specific_labs/chatbot/index.js aws-lab/specific_labs/chatbot/index.html > /dev/null

# Upload the frontend code bundle and wait until the function redeploys
echo Uploading frontend Lambda code...
aws lambda update-function-code --region us-east-2 --function-name aws-lab-chatbot-frontend --zip-file fileb://aws-lab/specific_labs/frontend.zip --output off
aws lambda wait function-updated --region us-east-2 --function-name aws-lab-chatbot-frontend

# Bundle chatbot Lambda files at the zip root (with "-j")
echo Bundling chatbot Lambda code...
zip -j aws-lab/specific_labs/chatbot.zip aws-lab/specific_labs/chatbot/chatbot_function.js > /dev/null

# Upload the chatbot code bundle and wait until the function redeploys
echo Uploading chatbot Lambda code...
aws lambda update-function-code --region us-east-2 --function-name aws-lab-chatbot-chatbot --zip-file fileb://aws-lab/specific_labs/chatbot.zip --output off
aws lambda wait function-updated --region us-east-2 --function-name aws-lab-chatbot-chatbot

# Create a test user in Amazon Cognito
echo Creating Cognito test user...
USERNAME=testuser
COGNITO_POOL_ID=$(aws cloudformation describe-stacks --stack-name aws-lab-chatbot --region us-east-2 --query "Stacks[0].Outputs[?OutputKey=='CognitoPoolId'].OutputValue" --output text)
aws cognito-idp admin-create-user --region us-east-2 --username "$USERNAME" --message-action SUPPRESS --user-pool-id "$COGNITO_POOL_ID" --output off

# Set the test user's password using a guaranteed uppercase, lowercase, number, and symbol character in addition to 12 other characters
echo Setting Cognito test user password...
PASSWORD=$( (
  head -c 256 /dev/urandom | tr -dc "A-Z" | head -c 1
  head -c 256 /dev/urandom | tr -dc "a-z" | head -c 1
  head -c 256 /dev/urandom | tr -dc "0-9" | head -c 1
  head -c 2048 /dev/urandom | tr -dc "!@#%^*_+=" | head -c 1
  head -c 512 /dev/urandom | tr -dc "A-Za-z0-9" | head -c 12
) | fold -w1 | shuf | tr -d "\n")
aws cognito-idp admin-set-user-password --region us-east-2 --permanent --username "$USERNAME" --password "$PASSWORD" --user-pool-id "$COGNITO_POOL_ID" --output off

# Create an accounts record for the user with a starting balance; user ID is based on the sub (a UUID) from Cognito
echo Setting test user account balance in DynamoDB...
SUB=$(aws cognito-idp admin-get-user --region us-east-2 --username "$USERNAME" --query "UserAttributes[?Name=='sub'].Value" --output text --user-pool-id "$COGNITO_POOL_ID")
aws dynamodb put-item --region us-east-2 --table-name aws-lab-chatbot-accounts --item "{\"userId\":{\"S\":\"$SUB\"},\"balance\":{\"N\":\"1234.56\"}}" --output off

# Output completion and further instructions
WEBPAGE=$(aws cloudformation describe-stacks --stack-name aws-lab-chatbot --region us-east-2 --query "Stacks[0].Outputs[?OutputKey=='FrontendUrl'].OutputValue" --output text)
echo "Setup complete!"
echo
echo "Webpage: $WEBPAGE"
echo "Username: $USERNAME"
echo "Password: $PASSWORD"
echo
echo To cleanup the lab environment after testing:
echo aws cloudformation delete-stack --region us-east-2 --stack-name aws-lab-chatbot
echo rm -rf aws-lab
echo
echo Note: delete and re-clone repo if redeploying since the sed command can only do one substitution per local copy