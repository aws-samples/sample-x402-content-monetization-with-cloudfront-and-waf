import ExpandableSection from '@cloudscape-design/components/expandable-section';

export function HelpGuide() {
  return (
    <ExpandableSection headerText="📖 How to use this editor" variant="footer">
      <div style={{ fontSize: 14, lineHeight: 1.7 }}>

        <h3 style={{ marginTop: 0 }}>Route evaluation order</h3>
        <p>
          Routes are evaluated <strong>top to bottom in priority order</strong> — the first route whose pattern matches the request URL wins.
          Within a route, policies are also evaluated top to bottom — the first policy whose condition matches determines the action.
          Use the ↑↓ buttons to reorder routes and policies.
        </p>

        <h3>Pattern syntax</h3>
        <ul style={{ paddingLeft: 20 }}>
          <li><code>*</code> — matches a single path segment (e.g. <code>/api/*</code> matches <code>/api/users</code> but not <code>/api/users/123</code>)</li>
          <li><code>**</code> — matches multiple path segments (e.g. <code>/api/**</code> matches <code>/api/users/123/posts</code>)</li>
          <li>Exact paths like <code>/pricing</code> match literally</li>
          <li><code>/**</code> — catch-all, matches everything (put this last)</li>
        </ul>

        <h3>Conditions</h3>
        <p>
          Each policy has a <strong>condition</strong> that determines when it applies. Conditions match against
          {' '}<a href="https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-bot.html" target="_blank" rel="noopener">AWS WAF Bot Control labels</a> attached to incoming requests.
        </p>
        <ul style={{ paddingLeft: 20 }}>
          <li><strong>WAF Label</strong> — exact match on a specific label (e.g. "Verified Bot", "AI Bot")</li>
          <li><strong>Namespace</strong> — prefix match on a label namespace (e.g. "All Bot Categories" matches any <code>bot:category:*</code>)</li>
          <li><strong>Custom</strong> — free-text for any WAF label string not in the catalog</li>
          <li><strong>AND / OR</strong> — combine multiple conditions; use the combinator dropdown between rules</li>
          <li><strong>NOT</strong> — negate a group using the ¬ toggle on a group</li>
          <li><strong>Default</strong> — fallback policy that matches any request not matched by prior policies. Should be the last policy in a route.</li>
        </ul>

        <h3>Actions</h3>
        <ul style={{ paddingLeft: 20 }}>
          <li><strong>💲 Price (USD)</strong> — triggers x402 payment flow. The agent must pay this amount in USDC per request (e.g. <code>0.001</code>)</li>
          <li><strong>✅ Free (0)</strong> — allows access without payment</li>
          <li><strong>🚫 Block</strong> — denies access at the WAF layer (returns 403, never reaches your origin)</li>
        </ul>

        <h3>Limitations</h3>
        <ul style={{ paddingLeft: 20 }}>
          <li><strong>Condition nesting depth: max 5 levels.</strong> AWS WAF limits how deeply AND/OR/NOT groups can be nested. The editor will warn you if you exceed this.</li>
          <li><strong>WAF capacity: 300 WCU.</strong> Each policy becomes a WAF rule. ~16 WCU is reserved for system rules (guard rule + bot signal forwarding), leaving ~284 WCU for your route policies. The capacity bar above the route list shows current usage.</li>
          <li><strong>Max 20 policies per route.</strong> If you need more, consider splitting into multiple routes with more specific patterns.</li>
          <li><strong>One default policy per route, must be last.</strong> The default matches everything — any policies after it are unreachable.</li>
          <li><strong>Route order matters.</strong> Routes are evaluated top to bottom. The first matching route wins. Put specific patterns before broad ones.</li>
          <li><strong>Policy order matters.</strong> Within a route, policies are evaluated top to bottom. The first matching condition determines the action.</li>
        </ul>

        <h3>Deploying your config</h3>
        <p>
          Click <strong>Copy</strong> next to the JSON output to copy the minified config to your clipboard, then push it to SSM Parameter Store:
        </p>
        <pre style={{ background: '#1e1e1e', color: '#d4d4d4', padding: 10, borderRadius: 4, overflow: 'auto', fontSize: 13 }}>{
`aws ssm put-parameter \\
  --name "/x402-edge/<your-stack-name>/config/routes" \\
  --value '<paste JSON here>' \\
  --type String \\
  --overwrite`
        }</pre>
        <p>
          Changes propagate to WAF within seconds via EventBridge.
          No redeployment needed.
        </p>

        <h3>Tips</h3>
        <ul style={{ paddingLeft: 20 }}>
          <li>Put more specific routes (e.g. <code>/api/sports.json</code>) before broader ones (e.g. <code>/**</code>)</li>
          <li>Always end with a <strong>default</strong> policy as the last policy in your catch-all route</li>
          <li>Use <strong>Import</strong> to load your existing config, edit visually, then export</li>
          <li>The JSON preview updates in real time — verify it looks right before deploying</li>
          <li>Verified bots (Googlebot, Bingbot, etc.) are independently verified by AWS WAF — safe to give lower prices</li>
          <li>Unverified bots self-identify but can be spoofed — consider higher prices or blocking</li>
        </ul>
      </div>
    </ExpandableSection>
  );
}
