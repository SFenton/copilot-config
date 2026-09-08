import { z } from 'zod';

export function evidenceSchemas(mode) {
  const repo = mode !== 'external';
  const web = mode !== 'repository';
  return {
    find: {
      scope: z.enum(repo && web ? ['repository', 'external'] : repo ? ['repository'] : ['external']),
      ...(repo ? { query: z.string().max(160).optional() } : {}),
      ...(web ? { queryId: z.string().max(40).optional() } : {}),
      limit: z.number().int().min(1).max(8).optional(),
    },
    open: {
      id: web && !repo ? z.string().min(1).max(80) : z.string().max(80).optional(),
      ...(repo ? {
        path: z.string().max(300).optional(), symbol: z.string().max(120).optional(),
        start: z.number().int().min(1).optional(), end: z.number().int().min(1).optional(),
      } : {}),
      ...(web ? { focus: z.string().max(160).optional(), refresh: z.boolean().optional() } : {}),
      maxCharacters: z.number().int().min(500).max(64000).optional(), reopen: z.boolean().optional(),
    },
  };
}
