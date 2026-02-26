import { useState } from 'react';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Input from '@cloudscape-design/components/input';
import Link from '@cloudscape-design/components/link';
import FormField from '@cloudscape-design/components/form-field';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Box from '@cloudscape-design/components/box';

const STACK_KEY = 'x402-editor-stack-name';
const REGION_KEY = 'x402-editor-region';

/** Config injected by the editor-deploy Lambda at deploy time. */
interface StackConfig { stackName: string; region: string; wafWebAclId?: string; cfDistributionId?: string }
const injected: StackConfig | undefined = (window as unknown as Record<string, unknown>).__X402_STACK_CONFIG__ as StackConfig | undefined;

function load(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

/** Encode an SSM parameter path for use in a Console URL (slashes → %2F, then encode the rest). */
/** Encode an SSM parameter path for use in a Console URL — keep slashes literal, encode each segment. */
function ssmParamUrl(region: string, paramPath: string): string {
  const encodedPath = paramPath
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  return `https://${region}.console.aws.amazon.com/systems-manager/parameters${encodedPath}/description?region=${region}`;
}

interface LinkEntry { label: string; href: string; description: string }

function buildLinks(stack: string, region: string, wafWebAclId?: string, cfDistributionId?: string): LinkEntry[] {
  const prefix = `/x402-edge/${stack}/config`;
  return [
    {
      label: '📋 Routes config',
      href: ssmParamUrl(region, `${prefix}/routes`),
      description: 'Route/pricing JSON — the main config you edit here',
    },
    {
      label: '💰 PayTo address',
      href: ssmParamUrl(region, `${prefix}/payto`),
      description: 'Ethereum wallet that receives USDC payments',
    },
    {
      label: '🔗 Network',
      href: ssmParamUrl(region, `${prefix}/network`),
      description: 'Blockchain network (Base Sepolia or Mainnet)',
    },
    {
      label: '🌐 Facilitator URL',
      href: ssmParamUrl(region, `${prefix}/facilitator-url`),
      description: 'Payment verification service endpoint',
    },
    {
      label: '🔑 CDP Credentials',
      href: `https://${region}.console.aws.amazon.com/secretsmanager/secret?name=x402-edge/${stack}/cdp-credentials&region=${region}`,
      description: 'CDP API key in Secrets Manager (only when using CDP facilitator)',
    },
    {
      label: '🛡️ WAF Web ACL',
      href: wafWebAclId
        ? `https://${region}.console.aws.amazon.com/wafv2/homev2/web-acl/${stack}-web-acl/${wafWebAclId}/overview?region=global`
        : `https://${region}.console.aws.amazon.com/wafv2/homev2/web-acls?region=global`,
      description: 'Web ACL with Bot Control + dynamic rule group',
    },
    {
      label: '📊 CloudWatch Dashboard',
      href: `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#dashboards:name=x402-edge-${stack}`,
      description: 'Revenue metrics, payment counts, latency',
    },
    {
      label: '☁️ CloudFront Distribution',
      href: cfDistributionId
        ? `https://${region}.console.aws.amazon.com/cloudfront/v4/home#/distributions/${cfDistributionId}`
        : `https://${region}.console.aws.amazon.com/cloudfront/v4/home#/distributions`,
      description: cfDistributionId ? 'Edge distribution settings and behaviors' : 'Edge distribution (filter by stack name)',
    },
    {
      label: '📦 CloudFormation Stack',
      href: `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks?filteringText=${stack}`,
      description: 'Full stack resources, outputs, and parameters',
    },
  ];
}

export function AwsConsoleLinks() {
  const [stackName, setStackName] = useState(() => injected?.stackName || load(STACK_KEY, ''));
  const [region, setRegion] = useState(() => injected?.region || load(REGION_KEY, 'us-east-1'));

  const isInjected = Boolean(injected?.stackName);

  const updateStack = (v: string) => { setStackName(v); save(STACK_KEY, v); };
  const updateRegion = (v: string) => { setRegion(v); save(REGION_KEY, v); };

  const ready = stackName.trim().length > 0 && region.trim().length > 0;
  const links = ready ? buildLinks(stackName.trim(), region.trim(), injected?.wafWebAclId, injected?.cfDistributionId) : [];

  return (
    <ExpandableSection headerText="🔗 AWS Console Quick Links" defaultExpanded={isInjected}>
      <SpaceBetween size="m">
        <ColumnLayout columns={2}>
          <FormField label="Stack name" description={isInjected ? 'Auto-detected from deployment' : 'Your CloudFormation stack name (from samconfig.toml)'}>
            <Input value={stackName} onChange={({ detail }) => updateStack(detail.value)} placeholder="x402-solution-1" readOnly={isInjected} />
          </FormField>
          <FormField label="Region" description={isInjected ? 'Auto-detected from deployment' : 'AWS region where the stack is deployed'}>
            <Input value={region} onChange={({ detail }) => updateRegion(detail.value)} placeholder="us-east-1" readOnly={isInjected} />
          </FormField>
        </ColumnLayout>

        {!ready && (
          <Box color="text-status-inactive" fontSize="body-s">
            Enter your stack name above to generate direct links to the AWS Console.
          </Box>
        )}

        {ready && (
          <ColumnLayout columns={2} variant="text-grid">
            {links.map(l => (
              <div key={l.label}>
                <Link href={l.href} external fontSize="body-s">{l.label}</Link>
                <Box variant="small" color="text-body-secondary">{l.description}</Box>
              </div>
            ))}
          </ColumnLayout>
        )}
      </SpaceBetween>
    </ExpandableSection>
  );
}
