import { describe, expect, it } from 'bun:test'
import { adminLoginSchema, adminRechargeSchema, adminUserSchema, adminImageSchema } from '../src/schemas/admin'

describe('admin forms preserve authentication and exact recharge amounts', () => {
  it('trims the account but preserves password whitespace', () => {
    expect(adminLoginSchema.parse({ username: '  operator  ', password: ' secret ' })).toEqual({ username: 'operator', password: ' secret ' })
    expect(adminLoginSchema.safeParse({ username: '   ', password: 'x' }).success).toBe(false)
  })
  it('rejects zero, negatives, exponent syntax, fractional cents and non-finite amounts', () => {
    for (const amount of ['0', '-1', '1e3', '0.001', 'Infinity', 'NaN', '1.2.3', '']) {
      expect(adminRechargeSchema.safeParse({ amount }).success).toBe(false)
    }
    for (const amount of ['0.01', '10', '10.50']) expect(adminRechargeSchema.safeParse({ amount }).success).toBe(true)
  })
})


describe('admin artwork read contracts', () => {
  it('keeps accounts with no jobs in the directory alongside accounts with works', () => {
    const rows = adminUserSchema.array().parse([
      { id: 'visitor', imageCount: 0, lastCreated: null },
      { id: 'artist', imageCount: 2, lastCreated: 1_800_000_000_000 },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0].lastCreated).toBeNull()
    expect(rows[1].imageCount).toBe(2)
  })
  it('accepts local retained works without OSS URLs for protected preview fallback', () => {
    const image = adminImageSchema.parse({ id: 'image-0', jobId: 'a'.repeat(32), index: 0, created: 1_800_000_000_000, url: null, downloadUrl: null, hiddenUser: false })
    expect(image.url).toBeNull()
    expect(image.jobId).toHaveLength(32)
    expect(adminImageSchema.safeParse({ ...image, index: -1 }).success).toBe(false)
  })
})
