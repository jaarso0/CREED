import { GraphQueryPlan, AnchorSpec } from './types.js';

export function validateGraphQueryPlan(plan: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!plan || typeof plan !== 'object') {
    return { valid: false, errors: ['Request body must be a JSON object'] };
  }

  // Validate operation
  const allowedOps = ['region', 'path', 'impact'];
  if (!plan.operation || !allowedOps.includes(plan.operation)) {
    errors.push(`operation must be one of: ${allowedOps.join(', ')}`);
  }

  // Validate anchors
  if (!plan.anchors || !Array.isArray(plan.anchors) || plan.anchors.length === 0) {
    errors.push('anchors must be a non-empty array');
  } else {
    plan.anchors.forEach((anchor: any, idx: number) => {
      if (!anchor || typeof anchor !== 'object') {
        errors.push(`anchors[${idx}] must be an object`);
        return;
      }
      if (typeof anchor.query !== 'string' || anchor.query.trim() === '') {
        errors.push(`anchors[${idx}].query must be a non-empty string`);
      }
      if (anchor.resolution && !['exact', 'search', 'auto'].includes(anchor.resolution)) {
        errors.push(`anchors[${idx}].resolution must be one of: exact, search, auto`);
      }
    });
  }

  // Validate constraints
  if (plan.constraints) {
    if (typeof plan.constraints !== 'object') {
      errors.push('constraints must be an object');
    } else {
      const c = plan.constraints;
      if (c.direction && !['incoming', 'outgoing', 'both'].includes(c.direction)) {
        errors.push('constraints.direction must be one of: incoming, outgoing, both');
      }
      if (c.edgeKinds && (!Array.isArray(c.edgeKinds) || c.edgeKinds.some((k: any) => typeof k !== 'string'))) {
        errors.push('constraints.edgeKinds must be an array of strings');
      }
      if (c.requestedDepth !== undefined && (typeof c.requestedDepth !== 'number' || c.requestedDepth < 0)) {
        errors.push('constraints.requestedDepth must be a non-negative number');
      }
      if (c.requestedNodes !== undefined && (typeof c.requestedNodes !== 'number' || c.requestedNodes < 0)) {
        errors.push('constraints.requestedNodes must be a non-negative number');
      }
      if (c.requestedPaths !== undefined && (typeof c.requestedPaths !== 'number' || c.requestedPaths < 0)) {
        errors.push('constraints.requestedPaths must be a non-negative number');
      }
      if (c.searchMode !== undefined && typeof c.searchMode !== 'boolean') {
        errors.push('constraints.searchMode must be a boolean');
      }
      if (c.freeFormQuery !== undefined && typeof c.freeFormQuery !== 'string') {
        errors.push('constraints.freeFormQuery must be a string');
      }
      if (c.maxAnchors !== undefined && (typeof c.maxAnchors !== 'number' || c.maxAnchors < 1)) {
        errors.push('constraints.maxAnchors must be a positive number');
      }
    }
  }

  // Validate materialize
  if (plan.materialize) {
    if (typeof plan.materialize !== 'object') {
      errors.push('materialize must be an object');
    } else {
      const m = plan.materialize;
      const flags = ['source', 'callsites', 'signatures', 'docs'];
      flags.forEach(flag => {
        if (m[flag] !== undefined && typeof m[flag] !== 'boolean') {
          errors.push(`materialize.${flag} must be a boolean`);
        }
      });
    }
  }

  // Validate context
  if (plan.context) {
    if (typeof plan.context !== 'object') {
      errors.push('context must be an object');
    } else {
      if (plan.context.tokenBudget !== undefined && (typeof plan.context.tokenBudget !== 'number' || plan.context.tokenBudget < 0)) {
        errors.push('context.tokenBudget must be a non-negative number');
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
