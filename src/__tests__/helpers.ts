import { expect } from 'vitest';
import type { CreateItemRequest } from '../types/item.js';

/**
 * Asserts the status code and narrows the handler's result union to the
 * matching branch, so `result.body` can be read directly afterwards.
 */
export function expectStatus<R extends { statusCode: number }, S extends R['statusCode']>(
  result: R,
  status: S
): asserts result is Extract<R, { statusCode: S }> {
  expect(result.statusCode).toBe(status);
}

export function validItemData(overrides: Partial<CreateItemRequest> = {}): CreateItemRequest {
  return {
    subject: 'AP Biology',
    itemType: 'multiple-choice',
    difficulty: 3,
    content: {
      question: 'What is photosynthesis?',
      options: ['A', 'B', 'C', 'D'],
      correctAnswer: 'A',
      explanation: 'Photosynthesis is the process...',
    },
    metadata: {
      author: 'test-author',
      status: 'draft',
      tags: ['biology', 'photosynthesis'],
    },
    securityLevel: 'standard',
    ...overrides,
  };
}
