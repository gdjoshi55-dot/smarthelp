import { describe, expect, it } from 'vitest';
import { ApiHttpError } from '@/lib/api';
import {
  email,
  int,
  normalizePhone,
  oneOf,
  optionalStr,
  parsePaging,
  readJson,
  str,
  uuid,
  validateProfessionalApply,
  validateSendOtp,
  validateStaffSignIn,
  validateUpdateMe,
  validateVerifyOtp,
} from '@/lib/validation';

/**
 * The validators are the first of the three authorisation layers (§26.2), and
 * the one most likely to be quietly loosened by a later phase, so they are
 * pinned here: length caps, the phone shape, and the rule that `role` is not
 * something a request body can set.
 */

function fieldsOf(fn: () => unknown): Record<string, string> {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiHttpError);
    const err = e as ApiHttpError;
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.status).toBe(400);
    return (err.details?.fields ?? {}) as Record<string, string>;
  }
  throw new Error('expected the validator to throw, but it returned');
}

describe('str', () => {
  it('trims by default and can be told not to', () => {
    expect(str('  hello  ', 'x')).toBe('hello');
    expect(str('  hello  ', 'x', { trim: false })).toBe('  hello  ');
  });

  it('enforces a minimum and a maximum', () => {
    expect(fieldsOf(() => str('a', 'x', { min: 2 }))).toHaveProperty('x');
    expect(fieldsOf(() => str('a'.repeat(300), 'x', { max: 255 }))).toHaveProperty('x');
    expect(str('a'.repeat(255), 'x', { max: 255 })).toHaveLength(255);
  });

  it('refuses a non-string rather than coercing it', () => {
    expect(fieldsOf(() => str(42, 'x'))).toHaveProperty('x');
    expect(fieldsOf(() => str(null, 'x'))).toHaveProperty('x');
    expect(fieldsOf(() => str({ a: 1 }, 'x'))).toHaveProperty('x');
  });
});

describe('int', () => {
  it('accepts numeric strings, as HTML form fields send them', () => {
    expect(int('7', 'n')).toBe(7);
  });

  it('refuses fractions, NaN, Infinity and non-numbers', () => {
    expect(fieldsOf(() => int(1.5, 'n'))).toHaveProperty('n');
    expect(fieldsOf(() => int(Number.NaN, 'n'))).toHaveProperty('n');
    expect(fieldsOf(() => int(Number.POSITIVE_INFINITY, 'n'))).toHaveProperty('n');
    expect(fieldsOf(() => int('abc', 'n'))).toHaveProperty('n');
  });

  it('honours its bounds', () => {
    expect(fieldsOf(() => int(0, 'n', { min: 1 }))).toHaveProperty('n');
    expect(fieldsOf(() => int(11, 'n', { max: 10 }))).toHaveProperty('n');
    expect(int(10, 'n', { max: 10 })).toBe(10);
  });
});

describe('uuid', () => {
  it('accepts a v4 uuid in either case and lowercases it', () => {
    const id = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';
    expect(uuid(id, 'id')).toBe(id.toLowerCase());
  });

  it('refuses anything that is not exactly a uuid', () => {
    expect(fieldsOf(() => uuid('../../etc/passwd', 'id'))).toHaveProperty('id');
    expect(fieldsOf(() => uuid('3f2504e0-4f89-41d3-9a0c', 'id'))).toHaveProperty('id');
    expect(fieldsOf(() => uuid('3f2504e04f8941d39a0c0305e82c3301', 'id'))).toHaveProperty('id');
  });
});

describe('normalizePhone', () => {
  it('normalises the shapes an Indian user actually types to E.164', () => {
    expect(normalizePhone('9876543210')).toBe('+919876543210');
    expect(normalizePhone('+91 98765 43210')).toBe('+919876543210');
    expect(normalizePhone('919876543210')).toBe('+919876543210');
    expect(normalizePhone('09876543210')).toBe('+919876543210');
    expect(normalizePhone('98765-43210')).toBe('+919876543210');
    expect(normalizePhone('(98765) 43210')).toBe('+919876543210');
  });

  it('refuses numbers that do not start 6-9', () => {
    expect(fieldsOf(() => normalizePhone('1234567890'))).toHaveProperty('phone');
    expect(fieldsOf(() => normalizePhone('5876543210'))).toHaveProperty('phone');
  });

  it('refuses the wrong number of digits', () => {
    expect(fieldsOf(() => normalizePhone('987654321'))).toHaveProperty('phone');
    expect(fieldsOf(() => normalizePhone('98765432100'))).toHaveProperty('phone');
  });
});

describe('email', () => {
  it('lowercases a valid address', () => {
    expect(email('Admin@SmartHelp.IN')).toBe('admin@smarthelp.in');
  });

  it('refuses the shapes that are obviously wrong', () => {
    for (const bad of ['', 'nope', 'a@b', 'a b@c.com', '@c.com', 'a@.com']) {
      expect(fieldsOf(() => email(bad))).toHaveProperty('email');
    }
  });
});

describe('oneOf', () => {
  it('accepts a member and refuses everything else', () => {
    expect(oneOf('phone', 'channel', ['phone', 'email'] as const)).toBe('phone');
    expect(fieldsOf(() => oneOf('carrier_pigeon', 'channel', ['phone', 'email'] as const)))
      .toHaveProperty('channel');
  });
});

describe('optionalStr', () => {
  it('treats absent and empty as null, and still caps the length', () => {
    expect(optionalStr(undefined, 'bio')).toBeNull();
    expect(optionalStr('', 'bio')).toBeNull();
    expect(optionalStr(null, 'bio')).toBeNull();
    expect(optionalStr('hello', 'bio')).toBe('hello');
    expect(fieldsOf(() => optionalStr('x'.repeat(900), 'bio', { max: 800 }))).toHaveProperty('bio');
  });
});

describe('validateSendOtp', () => {
  it('reads the target from the field matching the channel', () => {
    expect(validateSendOtp({ channel: 'phone', phone: '9876543210' })).toEqual({
      channel: 'phone',
      purpose: 'login',
      target: '+919876543210',
    });
    expect(validateSendOtp({ channel: 'email', email: 'A@B.com' })).toEqual({
      channel: 'email',
      purpose: 'login',
      target: 'a@b.com',
    });
  });

  it('does not let a phone request borrow the email field, or vice versa', () => {
    expect(fieldsOf(() => validateSendOtp({ channel: 'phone' }))).toHaveProperty('phone');
    expect(fieldsOf(() => validateSendOtp({ channel: 'email' }))).toHaveProperty('email');
  });

  it('defaults the purpose to login and rejects an invented one', () => {
    expect(validateSendOtp({ channel: 'phone', phone: '9876543210' }).purpose).toBe('login');
    expect(
      fieldsOf(() =>
        validateSendOtp({ channel: 'phone', phone: '9876543210', purpose: 'become_admin' })
      )
    ).toHaveProperty('purpose');
  });
});

describe('validateVerifyOtp', () => {
  it('strips the separators people paste along with the code', () => {
    const out = validateVerifyOtp({
      channel: 'phone',
      phone: '9876543210',
      code: ' 123 456 ',
    });
    expect(out.code).toBe('123456');
  });

  it('refuses a code that is not all digits', () => {
    expect(
      fieldsOf(() =>
        validateVerifyOtp({ channel: 'phone', phone: '9876543210', code: '12345a' })
      )
    ).toHaveProperty('code');
  });

  it('refuses an empty code', () => {
    expect(
      fieldsOf(() => validateVerifyOtp({ channel: 'phone', phone: '9876543210', code: '' }))
    ).toHaveProperty('code');
  });
});

describe('validateStaffSignIn', () => {
  it('requires a plausible password but never trims it', () => {
    expect(validateStaffSignIn({ email: 'a@b.com', password: '  pass1234' }).password).toBe(
      '  pass1234'
    );
    expect(fieldsOf(() => validateStaffSignIn({ email: 'a@b.com', password: 'short' })))
      .toHaveProperty('password');
  });
});

describe('validateProfessionalApply', () => {
  const serviceId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  it('accepts a minimal application', () => {
    const out = validateProfessionalApply({ service_ids: [serviceId] });
    expect(out.serviceIds).toEqual([serviceId]);
    expect(out.documents).toEqual([]);
    expect(out.experienceMonths).toBe(0);
  });

  it('de-duplicates service ids', () => {
    expect(validateProfessionalApply({ service_ids: [serviceId, serviceId] }).serviceIds)
      .toEqual([serviceId]);
  });

  it('requires at least one service and caps the list', () => {
    expect(fieldsOf(() => validateProfessionalApply({ service_ids: [] }))).toHaveProperty(
      'service_ids'
    );
    const many = Array.from({ length: 41 }, () => serviceId);
    expect(fieldsOf(() => validateProfessionalApply({ service_ids: many }))).toHaveProperty(
      'service_ids'
    );
  });

  it('rejects a service id that is not a uuid', () => {
    expect(
      fieldsOf(() => validateProfessionalApply({ service_ids: ['1'] }))
    ).toHaveProperty('service_ids');
  });

  it('only accepts the known document types', () => {
    expect(
      fieldsOf(() =>
        validateProfessionalApply({
          service_ids: [serviceId],
          documents: [{ doc_type: 'selfie_of_the_admin', file_path: 'kyc/x.jpg' }],
        })
      )
    ).toHaveProperty('doc_type');
  });

  it('accepts a known document type', () => {
    const out = validateProfessionalApply({
      service_ids: [serviceId],
      documents: [{ doc_type: 'aadhaar_front', file_path: 'kyc/x.jpg' }],
    });
    expect(out.documents).toEqual([{ docType: 'aadhaar_front', filePath: 'kyc/x.jpg' }]);
  });
});

describe('validateUpdateMe', () => {
  it('accepts the fields a user may change about themselves', () => {
    const out = validateUpdateMe({ full_name: 'Asha Rao', locale: 'en-IN' });
    expect(out).toEqual({ full_name: 'Asha Rao', locale: 'en-IN' });
  });

  it('ignores anything it does not recognise, so a body cannot smuggle a role', () => {
    const out = validateUpdateMe({
      full_name: 'Asha Rao',
      role: 'super_admin',
      status: 'active',
      id: 'someone-else',
    } as Record<string, unknown>);
    expect(out).toEqual({ full_name: 'Asha Rao' });
    expect('role' in out).toBe(false);
    expect('status' in out).toBe(false);
  });

  it('refuses an empty patch instead of writing nothing', () => {
    expect(() => validateUpdateMe({})).toThrow(ApiHttpError);
  });

  it('refuses an unsupported locale', () => {
    expect(fieldsOf(() => validateUpdateMe({ locale: 'fr-FR' }))).toHaveProperty('locale');
  });
});

describe('readJson', () => {
  const jsonRequest = (body: string) =>
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

  it('accepts an object body', async () => {
    await expect(readJson(jsonRequest('{"a":1}'))).resolves.toEqual({ a: 1 });
  });

  it('refuses an array, a scalar, and malformed JSON', async () => {
    await expect(readJson(jsonRequest('[1,2]'))).rejects.toThrow(ApiHttpError);
    await expect(readJson(jsonRequest('"hello"'))).rejects.toThrow(ApiHttpError);
    await expect(readJson(jsonRequest('{oops'))).rejects.toThrow(ApiHttpError);
  });
});

describe('parsePaging', () => {
  it('defaults, and caps a client asking for the whole table', () => {
    expect(parsePaging(new URL('http://x/api'))).toEqual({ limit: 25, offset: 0 });
    expect(parsePaging(new URL('http://x/api?limit=5000')).limit).toBe(100);
    expect(parsePaging(new URL('http://x/api?limit=10')).limit).toBe(10);
  });

  it('never returns a negative offset or a zero limit', () => {
    expect(parsePaging(new URL('http://x/api?offset=-5')).offset).toBe(0);
    expect(parsePaging(new URL('http://x/api?limit=0')).limit).toBe(25);
  });

  it('falls back to the default on junk input rather than throwing', () => {
    expect(parsePaging(new URL('http://x/api?limit=abc')).limit).toBe(25);
  });
});
