import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ses from 'aws-cdk-lib/aws-ses';
import { Construct } from 'constructs';

export interface IntervwdStackProps extends cdk.StackProps {
  /** Shared secret CloudFront adds to every API request; the Lambda rejects calls without it. */
  originSecret: string;
  /** Our domain, with a Route 53 hosted zone in this account (intervwd.com). */
  domainName?: string;
  /** "bedrock" for live Amazon Nova, "mock" for rule-based questions and scoring. */
  novaMode: 'bedrock' | 'mock';
  /** A role in another account to call Nova through while this account's Bedrock quota is 0. */
  novaRoleArn?: string;
  /**
   * A send-only role in another account whose SES is out of the sandbox (IntervwdSesSender in
   * 975138397215). It must trust SERVER_ROLE_NAME and allow ses:SendEmail for the domain.
   */
  sesRoleArn?: string;
  /** Fixed sign-in code for the judges' demo account (demo@intervwd.com only). */
  demoCode?: string;
  /**
   * Which hostnames the distribution serves. "app" serves only app.<domain>: used once, while the
   * apex and www were still attached to a distribution in another account and had to be moved
   * across with `aws cloudfront associate-alias`. "all" (default) serves <domain>, www and app.
   */
  hostnames?: 'app' | 'all';
}

/** Fixed so a role in another account (Nova access) can trust it by name. */
export const SERVER_ROLE_NAME = 'intervwd-server';

// AWS Lambda Web Adapter (arm64): runs the Starlette app unchanged and streams responses.
const WEB_ADAPTER_LAYER_VERSION = 30;

export class IntervwdStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: IntervwdStackProps) {
    super(scope, id, props);
    const { domainName } = props;

    // Single table: orgs, jobs, rounds, candidates, interviews, sessions and sign-in codes.
    // pk/sk hold the item's place; gsi1 finds things by a second key (invite code, email, org).
    // Short-lived items (sign-in codes, OAuth codes) carry `expires` and are deleted by TTL.
    const table = new dynamodb.TableV2(this, 'Data', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      globalSecondaryIndexes: [
        {
          indexName: 'gsi1',
          partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
        },
      ],
      timeToLiveAttribute: 'expires',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // CVs and camera snapshots: private, encrypted, deleted after 90 days.
    const uploads = new s3.Bucket(this, 'Uploads', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const zone = domainName ? route53.HostedZone.fromLookup(this, 'Zone', { domainName }) : undefined;
    if (zone) {
      // Lets SES send sign-in codes and invites as no-reply@<domain>.
      new ses.EmailIdentity(this, 'EmailDomain', {
        identity: ses.Identity.publicHostedZone(zone),
        mailFromDomain: `mail.${domainName}`,
      });
      new route53.TxtRecord(this, 'Dmarc', { zone, recordName: '_dmarc', values: ['v=DMARC1; p=none;'] });
    }

    const role = new iam.Role(this, 'ServerRole', {
      roleName: SERVER_ROLE_NAME,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    const server = new lambda.Function(this, 'Server', {
      description: 'Intervwd web API, interview engine and MCP server for Alexa+',
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      handler: 'run.sh',
      role,
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'build', 'lambda')),
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(
          this,
          'WebAdapter',
          `arn:aws:lambda:${this.region}:753240598075:layer:LambdaAdapterLayerArm64:${WEB_ADAPTER_LAYER_VERSION}`,
        ),
      ],
      memorySize: 1024,
      timeout: cdk.Duration.seconds(60),
      logGroup: new logs.LogGroup(this, 'ServerLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
        AWS_LWA_INVOKE_MODE: 'response_stream',
        AWS_LWA_READINESS_CHECK_PATH: '/health',
        PORT: '8080',
        INTERVWD_TABLE: table.tableName,
        UPLOADS_BUCKET: uploads.bucketName,
        ORIGIN_SECRET: props.originSecret,
        NOVA_MODE: props.novaMode,
        NOVA_MODEL: 'global.amazon.nova-2-lite-v1:0',
        POLLY_VOICE: 'Kajal',
        ...(props.novaRoleArn ? { NOVA_ROLE_ARN: props.novaRoleArn } : {}),
        ...(props.sesRoleArn ? { SES_ROLE_ARN: props.sesRoleArn, SES_REGION: this.region } : {}),
        ...(props.demoCode ? { DEMO_CODE: props.demoCode } : {}),
        ...(domainName ? { APP_URL: `https://${domainName}`, MAIL_FROM: `Intervwd <no-reply@${domainName}>` } : {}),
      },
    });
    table.grantReadWriteData(server);
    uploads.grantReadWrite(server);
    server.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [`arn:aws:bedrock:*:${this.account}:inference-profile/*`, 'arn:aws:bedrock:*::foundation-model/amazon.nova-*'],
      }),
    );
    if (props.novaRoleArn) {
      server.addToRolePolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [props.novaRoleArn] }));
    }
    if (props.sesRoleArn) {
      server.addToRolePolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [props.sesRoleArn] }));
    }
    server.addToRolePolicy(new iam.PolicyStatement({ actions: ['polly:SynthesizeSpeech'], resources: ['*'] }));
    server.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`],
      }),
    );

    // Only CloudFront can reach the function: the URL needs the origin secret header to do anything.
    const url = server.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE, invokeMode: lambda.InvokeMode.RESPONSE_STREAM });

    const site = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const certificate = zone
      ? new acm.Certificate(this, 'Certificate', {
          domainName: domainName!,
          subjectAlternativeNames: [`www.${domainName}`, `app.${domainName}`],
          validation: acm.CertificateValidation.fromDns(zone),
        })
      : undefined;

    const api: cloudfront.BehaviorOptions = {
      origin: new origins.FunctionUrlOrigin(url, { customHeaders: { 'x-origin-secret': props.originSecret }, readTimeout: cdk.Duration.seconds(60) }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };

    // Single-page app: any path without a file extension serves index.html (React Router takes over).
    const spa = new cloudfront.Function(this, 'SpaRewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event) { var r = event.request; if (r.uri.indexOf('.') === -1) { r.uri = '/index.html'; } return r; }",
      ),
    });

    const distribution = new cloudfront.Distribution(this, 'Web', {
      comment: 'Intervwd web app and API',
      ...(certificate && {
        domainNames: props.hostnames === 'app' ? [`app.${domainName}`] : [domainName!, `www.${domainName}`, `app.${domainName}`],
        certificate,
      }),
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [{ function: spa, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': api,
        '/mcp': api,
        '/mcp/*': api,
        '/health': api,
        '/.well-known/*': api,
        '/oauth/*': api,
      },
    });

    new s3deploy.BucketDeployment(this, 'WebDeploy', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..', 'web', 'dist'))],
      destinationBucket: site,
      distribution,
      distributionPaths: ['/*'],
    });

    if (zone) {
      const target = route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution));
      new route53.ARecord(this, 'AppSubdomainRecord', { zone, recordName: 'app', target });
      new route53.ARecord(this, 'AppRecord', { zone, target });
      new route53.AaaaRecord(this, 'AppRecordV6', { zone, target });
      new route53.ARecord(this, 'WwwRecord', { zone, recordName: 'www', target });
      new route53.AaaaRecord(this, 'WwwRecordV6', { zone, recordName: 'www', target });
    }

    const appUrl = `https://${domainName ?? distribution.distributionDomainName}`;
    new cdk.CfnOutput(this, 'AppUrl', { value: appUrl, description: 'Intervwd web app' });
    new cdk.CfnOutput(this, 'McpUrl', { value: `${appUrl}/mcp`, description: 'MCP endpoint for Alexa+' });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'UploadsBucket', { value: uploads.bucketName });
    new cdk.CfnOutput(this, 'ServerRoleArn', { value: role.roleArn, description: 'Trust this role in the Nova account' });
  }
}
