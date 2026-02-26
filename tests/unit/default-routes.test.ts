/**
 * Validates that config/default-routes.json is a valid RouteConfig and stays
 * in sync with the template.yaml RouteConfigJson parameter default.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseRouteConfig } from '../../src/backoffice/waf-sync/route-config-validator';

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'default-routes.json');
const TEMPLATE_PATH = path.join(ROOT, 'template.yaml');

const configJson = fs.readFileSync(CONFIG_PATH, 'utf-8');

describe('config/default-routes.json', () => {
  it('is valid JSON that parses as a RouteConfig', () => {
    const result = parseRouteConfig(configJson);
    expect(result.success).toBe(true);
  });

  it('has at least one route', () => {
    const config = JSON.parse(configJson);
    expect(config.routes.length).toBeGreaterThan(0);
  });

  it('matches the RouteConfigJson default in template.yaml', () => {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');

    // Extract the JSON string from the YAML Default: > block
    const match = template.match(
      /RouteConfigJson:[\s\S]*?Default: >\n\s+(\{[^\n]+)/,
    );
    expect(match).not.toBeNull();

    const templateDefault = JSON.parse(match![1]);
    const fileConfig = JSON.parse(configJson);

    expect(templateDefault).toEqual(fileConfig);
  });
});
