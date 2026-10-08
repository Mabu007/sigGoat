import { TradingSkill } from '../../types';

export interface ParsedSkillMetadata {
  id?: string;
  name?: string;
  description?: string;
  timeframes?: string[];
}

export class SkillParser {
  /**
   * Parse a raw Markdown file into a Normalized TradingSkill
   */
  static parse(rawMarkdown: string, defaultUserId: string = 'current_user', fallbackId?: string): TradingSkill {
    const trimmed = rawMarkdown.trim();
    let frontmatterContent = '';
    let body = trimmed;

    // Check for YAML frontmatter
    if (trimmed.startsWith('---')) {
      const secondFenceIndex = trimmed.indexOf('---', 3);
      if (secondFenceIndex !== -1) {
        frontmatterContent = trimmed.substring(3, secondFenceIndex).trim();
        body = trimmed.substring(secondFenceIndex + 3).trim();
      }
    }

    const metadata: ParsedSkillMetadata = this.parseFrontmatter(frontmatterContent);

    // Extract title from first H1 if name not in frontmatter
    let name = metadata.name || '';
    if (!name) {
      const h1Match = body.match(/^#\s+(.+)$/m);
      if (h1Match) {
        name = h1Match[1].trim();
      } else {
        name = 'Custom Trading Skill';
      }
    }

    // Extract description (first paragraph under title or frontmatter)
    let description = metadata.description || '';
    if (!description) {
      const lines = body.split('\n');
      for (const line of lines) {
        const clean = line.trim();
        if (clean && !clean.startsWith('#') && !clean.startsWith('---') && !clean.startsWith('-')) {
          description = clean.slice(0, 160);
          break;
        }
      }
      if (!description) description = `${name} methodology and rules`;
    }

    // Extract Recognized Machine-Enforceable Constraints
    const constraintsList: string[] = [];
    const constraintSectionMatch = body.match(/##\s+Constraints[\s\S]*?(?=(?:##|$))/i);
    if (constraintSectionMatch) {
      const sectionText = constraintSectionMatch[0];
      const recognized = [
        'REQUIRE_INVALIDATION_BEFORE_TRADE',
        'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE',
        'MINIMUM_RR_2_TO_1',
        'NO_COUNTER_TREND_WITHOUT_CHoCH',
        'WAIT_FOR_SESSION_OPEN_CONFIRMATION',
        'LIMIT_ORDERS_ONLY',
      ];
      for (const token of recognized) {
        if (new RegExp(`\\b${token}\\b`, 'i').test(sectionText)) {
          constraintsList.push(token);
        }
      }
      // Also grab bullet points
      const bullets = sectionText.match(/[-*]\s+(.+)/g);
      if (bullets) {
        bullets.forEach(b => constraintsList.push(b.replace(/^[-*]\s+/, '').trim()));
      }
    }

    // Extract Timeframes
    const preferredTimeframes: string[] = metadata.timeframes || [];
    const tfMatches = body.match(/\b(1m|5m|15m|1h|4h|1d|daily)\b/gi);
    if (tfMatches) {
      tfMatches.forEach(tf => {
        const normalized = tf.toLowerCase() === 'daily' ? '1d' : tf.toLowerCase();
        if (!preferredTimeframes.includes(normalized)) {
          preferredTimeframes.push(normalized);
        }
      });
    }
    if (preferredTimeframes.length === 0) {
      preferredTimeframes.push('1h', '15m');
    }

    // Extract Invalidation Rules
    let invalidationRules = '';
    const invalidationMatch = body.match(/##\s+(?:Invalidation|Invalidation Rules)[\s\S]*?(?=(?:##|$))/i);
    if (invalidationMatch) {
      invalidationRules = invalidationMatch[0].replace(/##\s+(?:Invalidation|Invalidation Rules)/i, '').trim();
    } else {
      invalidationRules = 'Setup invalidates if key structural level or opposing liquidity is breached prior to fill.';
    }

    // Extract Required Evidence
    let requiredEvidence = '';
    const evidenceMatch = body.match(/##\s+(?:Thesis Formation|Required Evidence|Evidence)[\s\S]*?(?=(?:##|$))/i);
    if (evidenceMatch) {
      requiredEvidence = evidenceMatch[0].replace(/##\s+(?:Thesis Formation|Required Evidence|Evidence)/i, '').trim();
    } else {
      requiredEvidence = 'Liquidity displacement and higher timeframe structural alignment.';
    }

    const id = metadata.id || fallbackId || `skill_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${Date.now()}`;

    return {
      id,
      userId: defaultUserId,
      name,
      description,
      methodology: body,
      constraints: constraintsList.length > 0 ? constraintsList.join(', ') : 'Strict structural confirmation enforced',
      preferredTimeframes,
      requiredEvidence,
      invalidationRules,
      rawMarkdown, // PRESERVE PRISTINE MARKDOWN FILE
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private static parseFrontmatter(text: string): ParsedSkillMetadata {
    if (!text) return {};
    const meta: ParsedSkillMetadata = {};
    const lines = text.split('\n');
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx !== -1) {
        const key = line.substring(0, idx).trim().toLowerCase();
        const val = line.substring(idx + 1).trim();
        if (key === 'id') meta.id = val;
        else if (key === 'name') meta.name = val;
        else if (key === 'description') meta.description = val;
        else if (key === 'timeframes') meta.timeframes = val.split(',').map(s => s.trim());
      }
    }
    return meta;
  }
}
