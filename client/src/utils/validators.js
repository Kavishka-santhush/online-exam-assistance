/**
 * Zod schemas for the create/edit forms (react-hook-form + @hookform/resolvers
 * consume these directly). They intentionally mirror — but do not import from —
 * the server's validation, so a form can be blocked client-side before a round
 * trip, while the server stays the authoritative gate.
 */

import { z } from 'zod';
import { EXAM_TYPE, EXAM_ACCESS, RESULT_VISIBILITY } from './examConstants';
import { QUESTION_TYPE } from './questionTypes';

export const examBasicsSchema = z.object({
  title: z.string().trim().min(3, 'Give the exam a descriptive title').max(160),
  description: z.string().trim().max(2000).optional().or(z.literal('')),
  type: z.nativeEnum(EXAM_TYPE),
  category: z.string().trim().max(80).optional().or(z.literal('')),
  language: z.string().trim().min(2).max(10).default('en'),
});

export const examScheduleSchema = z
  .object({
    startsAt: z.coerce.date().optional().or(z.literal('')),
    endsAt: z.coerce.date().optional().or(z.literal('')),
    publishedAt: z.coerce.date().optional().or(z.literal('')),
    gradesReleasedAt: z.coerce.date().optional().or(z.literal('')),
  })
  .refine(
    (data) => !(data.startsAt && data.endsAt) || data.endsAt > data.startsAt,
    { message: 'End time must be after the start time', path: ['endsAt'] },
  );

export const examSettingsSchema = z.object({
  passingScorePercent: z.coerce.number().min(0).max(100),
  attemptLimit: z.coerce.number().int().min(1).max(100),
  timeLimitSec: z.coerce.number().int().min(0).nullable().optional(),
  negativeMarking: z.object({ enabled: z.boolean(), percent: z.coerce.number().min(0).max(100) }),
  shuffleQuestions: z.boolean(),
  shuffleOptions: z.boolean(),
  resultVisibility: z.nativeEnum(RESULT_VISIBILITY),
  access: z.nativeEnum(EXAM_ACCESS),
  isProctored: z.boolean(),
});

export const optionSchema = z.object({
  id: z.string().optional(),
  text: z.string().trim().min(1, 'Option text is required'),
  correct: z.boolean().default(false),
});

export const questionSchema = z
  .object({
    type: z.nativeEnum(QUESTION_TYPE),
    prompt: z.string().trim().min(1, 'Enter the question text'),
    marks: z.coerce.number().min(0.5, 'Marks must be greater than zero'),
    difficulty: z.enum(['EASY', 'MEDIUM', 'HARD', 'EXPERT']).default('MEDIUM'),
    options: z.array(optionSchema).optional(),
    explanation: z.string().trim().max(4000).optional().or(z.literal('')),
  })
  .superRefine((question, ctx) => {
    const choiceTypes = [QUESTION_TYPE.MULTIPLE_CHOICE, QUESTION_TYPE.MULTIPLE_ANSWER];
    if (choiceTypes.includes(question.type)) {
      const opts = question.options ?? [];
      if (opts.length < 2) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Choice questions need at least 2 options' });
      }
      const correctCount = opts.filter((option) => option.correct).length;
      if (question.type === QUESTION_TYPE.MULTIPLE_CHOICE && correctCount !== 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Single-answer questions need exactly one correct option' });
      }
      if (question.type === QUESTION_TYPE.MULTIPLE_ANSWER && correctCount < 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Select-all questions need at least one correct option' });
      }
    }
    if (question.type === QUESTION_TYPE.TRUE_FALSE) {
      const truthy = question.options?.find((option) => option.correct);
      if (!truthy) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Mark which of True / False is correct' });
      }
    }
  });

export const inviteSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  role: z.enum(['CANDIDATE', 'INSTRUCTOR', 'PROCTOR', 'ORG_ADMIN', 'VIEWER']),
});

export const feedbackSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional().or(z.literal('')),
});

/** Convenience: run a schema and return `{ ok, errors }` keyed by field path. */
export function validate(schema, values) {
  const result = schema.safeParse(values);
  if (result.success) return { ok: true, errors: {}, data: result.data };
  const errors = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    if (!errors[key]) errors[key] = issue.message;
  }
  return { ok: false, errors, data: values };
}

export default validate;
