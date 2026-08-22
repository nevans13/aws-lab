# aws-lab
CloudFormation code for AWS lab environment

## Installation
### Prerequisites
1 - Create an EC2 keypair (default name "aws-lab-keypair")\
2 - Subscribe to the OPNsense AMI in AWS Marketplace\
3 - Deploy Cloudformation template:\

    aws configure --profile aws-lab
    set AWS_PROFILE=aws-lab
    aws cloudformation create-stack --region us-east-2 --stack-name aws-lab --template-body file://cloudformation.yaml
    aws cloudformation wait stack-create-complete --region us-east-2 --stack-name aws-lab
    aws cloudformation describe-stacks --region us-east-2 --query "Stacks[*].[StackName,StackStatus]" --output table
    aws cloudformation describe-stacks --stack-name aws-lab --query "Stacks[0].Outputs" --output table

## Cleanup
The system is meant to be easily decommissioned using:

    aws cloudformation delete-stack --region us-east-2 --stack-name ffg-voice-dev
