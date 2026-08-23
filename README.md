# aws-lab
CloudFormation code for AWS lab environment

## Overview
This repository contains code for various lab systems in AWS. Primary networking is provided by OPNsense.

## Installation
### Prerequisites
1 - Create an EC2 keypair (default name "aws-lab-keypair")\
2 - Subscribe to the OPNsense AMI in AWS Marketplace and determine the AMI ID for the specific region\
3 - Deploy Cloudformation template in any desired region(s):

    aws configure --profile aws-lab
    set AWS_PROFILE=aws-lab
    aws cloudformation create-stack --region us-east-2 --stack-name aws-lab --template-body file://cloudformation.yaml --parameters ParameterKey=OpnsenseAmiId,ParameterValue=<AMI> ParameterKey=AdminCidrForMgmt,ParameterValue=<IP>/32
    aws cloudformation wait stack-create-complete --stack-name aws-lab --region us-east-2
    aws cloudformation describe-stacks --query "Stacks[*].[StackName,StackStatus]" --output table --region us-east-2
    aws cloudformation describe-stacks --stack-name aws-lab --query "Stacks[0].Outputs" --output table --region us-east-2

    aws cloudformation create-stack --region us-west-1 --stack-name aws-lab --template-body file://cloudformation.yaml --parameters ParameterKey=OpnsenseAmiId,ParameterValue=<AMI> ParameterKey=AdminCidrForMgmt,ParameterValue=<IP>/32
    aws cloudformation wait stack-create-complete --stack-name aws-lab --region us-west-1
    aws cloudformation describe-stacks --query "Stacks[*].[StackName,StackStatus]" --output table --region us-west-1
    aws cloudformation describe-stacks --stack-name aws-lab --query "Stacks[0].Outputs" --output table --region us-west-1

4 - SSH to the OPNsense instance as ec2-user and set the root user password (option 3):

    sudo /usr/local/sbin/opnsense-shell

## Cleanup
The system is meant to be easily decommissioned using:

    aws cloudformation delete-stack --region us-east-2 --stack-name aws-lab
    aws cloudformation delete-stack --region us-west-1 --stack-name aws-lab

## OPNsense Tasks
1 - Complete system update (System > Firmware > Status: Check for Updates)
2 - Install the FRR plugin for dynamic routing (System > Firmware > Plugins: Add *os-frr*)
