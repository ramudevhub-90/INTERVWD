import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { IntervwdStack } from '../lib/intervwd-stack';

// Kept in a gitignored file so it stays the same across deploys without living in the repo.
const secretFile = path.join(__dirname, '..', '.origin-secret');
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(24).toString('hex'));
const originSecret = readFileSync(secretFile, 'utf8').trim();

// Fixed sign-in code for the judges' demo account: the DEMO_CODE secret in CI, else a local gitignored file.
const demoFile = path.join(__dirname, '..', '.demo-code');
if (!process.env.DEMO_CODE && !existsSync(demoFile)) writeFileSync(demoFile, String(100000 + (randomBytes(4).readUInt32BE() % 900000)));
const demoCode = process.env.DEMO_CODE || readFileSync(demoFile, 'utf8').trim();

const app = new cdk.App();
const ctx = (key: string): string | undefined => app.node.tryGetContext(key) || undefined;

new IntervwdStack(app, 'Intervwd', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  description: 'Intervwd: AI interview platform for Alexa+ (API and MCP server on Lambda, web app on CloudFront)',
  originSecret,
  domainName: ctx('domain'), // -c domain=intervwd.com
  novaMode: ctx('nova') === 'mock' ? 'mock' : 'bedrock',
  novaRoleArn: ctx('novaRole'), // -c novaRole=arn:aws:iam::<other>:role/<name> while this account's quota is 0
  sesRoleArn: ctx('sesRole'), // -c sesRole=arn:aws:iam::<account>:role/<name>: send email through that account's SES
  demoCode,
  hostnames: ctx('hostnames') === 'app' ? 'app' : 'all',
});
