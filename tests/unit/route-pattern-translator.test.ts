/**
 * Unit tests for the route pattern translator.
 *
 * Tests the conversion of glob patterns from Route_Config into
 * WAF byte-match or regex-match statements.
 *
 */

import { toWafStatement } from '../../src/backoffice/waf-sync/route-pattern-translator';

describe('toWafStatement', () => {
  describe('exact paths (no wildcards) → ByteMatch EXACTLY', () => {
    it('should translate /pricing to EXACTLY /pricing', () => {
      const result = toWafStatement('/pricing');

      expect(result.byteMatchStatement).toBeDefined();
      expect(result.regexMatchStatement).toBeUndefined();
      expect(result.byteMatchStatement!.positionalConstraint).toBe('EXACTLY');
      expect(result.byteMatchStatement!.searchString).toBe('/pricing');
      expect(result.byteMatchStatement!.fieldToMatch).toEqual({ uriPath: {} });
      expect(result.byteMatchStatement!.textTransformations).toEqual([{ priority: 0, type: 'NONE' }]);
    });

    it('should translate root path / to EXACTLY /', () => {
      const result = toWafStatement('/');

      expect(result.byteMatchStatement).toBeDefined();
      expect(result.byteMatchStatement!.positionalConstraint).toBe('EXACTLY');
      expect(result.byteMatchStatement!.searchString).toBe('/');
    });

    it('should translate /api/v1/data to EXACTLY /api/v1/data', () => {
      const result = toWafStatement('/api/v1/data');

      expect(result.byteMatchStatement).toBeDefined();
      expect(result.byteMatchStatement!.positionalConstraint).toBe('EXACTLY');
      expect(result.byteMatchStatement!.searchString).toBe('/api/v1/data');
    });

    it('should translate path with dots /api/sports.json to EXACTLY', () => {
      const result = toWafStatement('/api/sports.json');

      expect(result.byteMatchStatement).toBeDefined();
      expect(result.byteMatchStatement!.positionalConstraint).toBe('EXACTLY');
      expect(result.byteMatchStatement!.searchString).toBe('/api/sports.json');
    });
  });

  describe('trailing multi-segment wildcard (/**) → ByteMatch STARTS_WITH', () => {
    it('should translate /api/** to STARTS_WITH /api/', () => {
      const result = toWafStatement('/api/**');

      expect(result.byteMatchStatement).toBeDefined();
      expect(result.regexMatchStatement).toBeUndefined();
      expect(result.byteMatchStatement!.positionalConstraint).toBe('STARTS_WITH');
      expect(result.byteMatchStatement!.searchString).toBe('/api/');
      expect(result.byteMatchStatement!.fieldToMatch).toEqual({ uriPath: {} });
    });

    it('should translate /articles/** to STARTS_WITH /articles/', () => {
      const result = toWafStatement('/articles/**');

      expect(result.byteMatchStatement).toBeDefined();
      expect(result.byteMatchStatement!.positionalConstraint).toBe('STARTS_WITH');
      expect(result.byteMatchStatement!.searchString).toBe('/articles/');
    });

    it('should translate /** to STARTS_WITH /', () => {
      const result = toWafStatement('/**');

      expect(result.byteMatchStatement).toBeDefined();
      expect(result.byteMatchStatement!.positionalConstraint).toBe('STARTS_WITH');
      expect(result.byteMatchStatement!.searchString).toBe('/');
    });

    it('should translate /api/premium/** to STARTS_WITH /api/premium/', () => {
      const result = toWafStatement('/api/premium/**');

      expect(result.byteMatchStatement).toBeDefined();
      expect(result.byteMatchStatement!.positionalConstraint).toBe('STARTS_WITH');
      expect(result.byteMatchStatement!.searchString).toBe('/api/premium/');
    });
  });

  describe('trailing single-segment wildcard (/*) → RegexMatch', () => {
    it('should translate /api/* to regex ^/api/[^/]*$', () => {
      const result = toWafStatement('/api/*');

      expect(result.regexMatchStatement).toBeDefined();
      expect(result.byteMatchStatement).toBeUndefined();
      expect(result.regexMatchStatement!.regexString).toBe('^/api/[^/]*$');
      expect(result.regexMatchStatement!.fieldToMatch).toEqual({ uriPath: {} });
      expect(result.regexMatchStatement!.textTransformations).toEqual([{ priority: 0, type: 'NONE' }]);
    });

    it('should translate /api/v1/* to regex ^/api/v1/[^/]*$', () => {
      const result = toWafStatement('/api/v1/*');

      expect(result.regexMatchStatement).toBeDefined();
      expect(result.regexMatchStatement!.regexString).toBe('^/api/v1/[^/]*$');
    });

    it('should translate /* to regex ^/[^/]*$', () => {
      const result = toWafStatement('/*');

      expect(result.regexMatchStatement).toBeDefined();
      expect(result.regexMatchStatement!.regexString).toBe('^/[^/]*$');
    });
  });

  describe('mid-segment wildcards → RegexMatch', () => {
    it('should translate /api/v*/data to regex ^/api/v[^/]*/data$', () => {
      const result = toWafStatement('/api/v*/data');

      expect(result.regexMatchStatement).toBeDefined();
      expect(result.byteMatchStatement).toBeUndefined();
      expect(result.regexMatchStatement!.regexString).toBe('^/api/v[^/]*/data$');
    });

    it('should translate /*/data to regex ^/[^/]*/data$', () => {
      const result = toWafStatement('/*/data');

      expect(result.regexMatchStatement).toBeDefined();
      expect(result.regexMatchStatement!.regexString).toBe('^/[^/]*/data$');
    });
  });

  describe('mixed * and ** patterns → RegexMatch', () => {
    it('should translate /api/*/v/** to regex ^/api/[^/]*/v/.*$', () => {
      const result = toWafStatement('/api/*/v/**');

      expect(result.regexMatchStatement).toBeDefined();
      expect(result.regexMatchStatement!.regexString).toBe('^/api/[^/]*/v/.*$');
    });
  });

  describe('regex metacharacter escaping in literals', () => {
    it('should escape dots in mid-segment patterns', () => {
      const result = toWafStatement('/api/v*.min.js');

      expect(result.regexMatchStatement).toBeDefined();
      expect(result.regexMatchStatement!.regexString).toBe('^/api/v[^/]*\\.min\\.js$');
    });

    it('should escape parentheses in patterns', () => {
      const result = toWafStatement('/api/data(*)');

      expect(result.regexMatchStatement).toBeDefined();
      expect(result.regexMatchStatement!.regexString).toBe('^/api/data\\([^/]*\\)$');
    });
  });

  describe('all statements have correct structure', () => {
    const byteMatchPatterns = ['/pricing', '/api/**', '/**'];
    const regexPatterns = ['/api/*', '/api/v*/data'];

    it.each(byteMatchPatterns)('should have uriPath field for byte-match pattern %s', (pattern) => {
      const result = toWafStatement(pattern);
      expect(result.byteMatchStatement!.fieldToMatch).toEqual({ uriPath: {} });
    });

    it.each(byteMatchPatterns)('should have NONE text transformation for byte-match pattern %s', (pattern) => {
      const result = toWafStatement(pattern);
      expect(result.byteMatchStatement!.textTransformations).toEqual([{ priority: 0, type: 'NONE' }]);
    });

    it.each(regexPatterns)('should have uriPath field for regex pattern %s', (pattern) => {
      const result = toWafStatement(pattern);
      expect(result.regexMatchStatement!.fieldToMatch).toEqual({ uriPath: {} });
    });

    it.each(regexPatterns)('should have NONE text transformation for regex pattern %s', (pattern) => {
      const result = toWafStatement(pattern);
      expect(result.regexMatchStatement!.textTransformations).toEqual([{ priority: 0, type: 'NONE' }]);
    });
  });
});
