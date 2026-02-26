const P = 'awswaf:managed:aws:bot-control:';

export interface LabelEntry {
  label: string;
  displayName: string;
  description?: string;
}

export interface DynamicLabelEntry {
  prefix: string;
  displayName: string;
  placeholder: string;
  description?: string;
}

export interface LabelCategory {
  name: string;
  labels: LabelEntry[];
  dynamicLabels?: DynamicLabelEntry[];
}

export interface NamespaceEntry {
  namespace: string;
  displayName: string;
  description?: string;
}

export const labelCategories: LabelCategory[] = [
  {
    name: 'Bot Verification Status',
    labels: [
      { label: `${P}bot:verified`, displayName: 'Verified Bot', description: 'Bot that self-identifies and is independently verified' },
      { label: `${P}bot:unverified`, displayName: 'Unverified Bot', description: 'Bot that self-identifies but cannot be verified' },
      { label: `${P}bot:user_triggered:verified`, displayName: 'User-Triggered Bot (verified)', description: 'Verified bot invoked by end users' },
      { label: `${P}bot:developer_platform:verified`, displayName: 'Developer Platform Bot (verified)', description: 'Verified bot from dev platforms (e.g. Google Apps Script)' },
    ],
  },
  {
    name: 'Bot Category',
    labels: [
      { label: `${P}bot:category:ai`, displayName: 'AI Bot' },
      { label: `${P}bot:category:search_engine`, displayName: 'Search Engine' },
      { label: `${P}bot:category:content_fetcher`, displayName: 'Content Fetcher' },
      { label: `${P}bot:category:social_media`, displayName: 'Social Media' },
      { label: `${P}bot:category:advertising`, displayName: 'Advertising' },
      { label: `${P}bot:category:archiver`, displayName: 'Archiver' },
      { label: `${P}bot:category:seo`, displayName: 'SEO' },
      { label: `${P}bot:category:scraping_framework`, displayName: 'Scraping Framework' },
      { label: `${P}bot:category:http_library`, displayName: 'HTTP Library' },
      { label: `${P}bot:category:security`, displayName: 'Security' },
      { label: `${P}bot:category:monitoring`, displayName: 'Monitoring' },
      { label: `${P}bot:category:link_checker`, displayName: 'Link Checker' },
      { label: `${P}bot:category:email_client`, displayName: 'Email Client' },
      { label: `${P}bot:category:miscellaneous`, displayName: 'Miscellaneous' },
    ],
  },
  {
    name: 'Bot Identity',
    labels: [],
    dynamicLabels: [
      { prefix: `${P}bot:name:`, displayName: 'Bot Name', placeholder: 'googlebot' },
      { prefix: `${P}bot:organization:`, displayName: 'Bot Organization', placeholder: 'google' },
      { prefix: `${P}bot:vendor:`, displayName: 'Bot Vendor', placeholder: 'agentcore' },
      { prefix: `${P}bot:account:`, displayName: 'Bot Account (hash)', placeholder: 'abc123' },
    ],
  },
  {
    name: 'Web Bot Authentication',
    labels: [
      { label: `${P}bot:web_bot_auth:verified`, displayName: 'WBA Verified' },
      { label: `${P}bot:web_bot_auth:invalid`, displayName: 'WBA Invalid' },
      { label: `${P}bot:web_bot_auth:expired`, displayName: 'WBA Expired' },
      { label: `${P}bot:web_bot_auth:unknown_bot`, displayName: 'WBA Unknown Bot' },
    ],
  },
  {
    name: 'Signals',
    labels: [
      { label: `${P}signal:automated_browser`, displayName: 'Automated Browser' },
      { label: `${P}signal:known_bot_data_center`, displayName: 'Known Bot Data Center' },
      { label: `${P}signal:non_browser_user_agent`, displayName: 'Non-Browser User Agent' },
    ],
    dynamicLabels: [
      { prefix: `${P}signal:cloud_service_provider:`, displayName: 'Cloud Service Provider', placeholder: 'aws' },
    ],
  },
  {
    name: 'Targeted Signals',
    labels: [
      { label: `${P}targeted:signal:automated_browser`, displayName: 'Automated Browser (targeted)' },
      { label: `${P}targeted:signal:browser_automation_extension`, displayName: 'Browser Automation Extension' },
      { label: `${P}targeted:signal:browser_inconsistency`, displayName: 'Browser Inconsistency' },
    ],
  },
];

export const namespaceEntries: NamespaceEntry[] = [
  { namespace: `${P}bot:`, displayName: 'All Bot Control labels' },
  { namespace: `${P}bot:category:`, displayName: 'All Bot Categories' },
  { namespace: `${P}bot:name:`, displayName: 'All Bot Names' },
  { namespace: `${P}signal:`, displayName: 'All Signals' },
  { namespace: `${P}targeted:`, displayName: 'All Targeted' },
];

/** Flat list of all static labels for quick lookup */
export const allStaticLabels: LabelEntry[] = labelCategories.flatMap(c => c.labels);
