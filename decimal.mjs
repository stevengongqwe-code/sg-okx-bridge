import * as z from 'zod';

// Accept JSON numbers or decimal strings, then keep risk calculations numeric.
const decimalString = z.string().trim().regex(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/);
const decimalInput = z.union([z.number(), decimalString]).transform(value => Number(value));
export const positiveDecimal = decimalInput.pipe(z.number().finite().positive());
export const nonnegativeDecimal = decimalInput.pipe(z.number().finite().nonnegative());

// JavaScript's shortest round-trip decimal, expanded without exponent notation.
export function toPlainDecimal(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new RangeError('decimal must be a finite nonnegative number');
  const raw = String(value).toLowerCase();
  if (!raw.includes('e')) return raw.includes('.') ? raw.replace(/0+$/, '').replace(/\.$/, '') : raw;
  const [mantissa, exponentText] = raw.split('e');
  const exponent = Number(exponentText);
  const digits = mantissa.replace('.', '');
  const point = (mantissa.includes('.') ? mantissa.indexOf('.') : mantissa.length) + exponent;
  const expanded = point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length ? `${digits}${'0'.repeat(point - digits.length)}`
    : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return expanded.includes('.') ? expanded.replace(/0+$/, '').replace(/\.$/, '') : expanded;
}

export const decimalCliArg = (flag, value) => [flag, toPlainDecimal(value)];
