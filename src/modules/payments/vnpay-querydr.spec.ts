import {
  buildVnPayQueryDrRequestSignatureSource,
  buildVnPayQueryDrResponseSignatureSource,
  createVnPayQueryDrRequestId,
  signVnPayQueryDrRequest,
  signVnPayQueryDrResponse,
  VnPayHttpClient,
  VnPayPaymentProvider,
  VnPayProviderConfig,
  VnPayQueryDrAttempt,
  VnPayQueryDrError,
} from './vnpay-payment.provider';

const HASH_SECRET = 'querydr-test-secret';
const NOW = new Date('2026-09-22T01:46:40.000Z');
const TRANSACTION_CREATED_AT = new Date('2026-09-21T16:59:59.000Z');

const config: VnPayProviderConfig = {
  environment: 'sandbox',
  tmnCode: 'TESTTMNC',
  hashSecret: HASH_SECRET,
  paymentUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  apiUrl: 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction',
  returnUrl: 'https://app.example/payments/return',
  ipnUrl: 'https://api.example/payments/ipn',
  version: '2.1.0',
  timeoutMs: 10000,
};

function attempt(
  overrides: Partial<VnPayQueryDrAttempt> = {},
): VnPayQueryDrAttempt {
  return {
    provider: 'vnpay',
    providerOrderCode: 9001n,
    amountMinor: 125000n,
    currency: 'VND',
    transactionCreatedAt: TRANSACTION_CREATED_AT,
    knownTransactionNo: '123456',
    requestIpAddress: '127.0.0.1',
    ...overrides,
  };
}

function queryResponse(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    vnp_ResponseId: 'response-9001',
    vnp_Command: 'querydr',
    vnp_ResponseCode: '00',
    vnp_Message: 'Query successful',
    vnp_TmnCode: 'TESTTMNC',
    vnp_TxnRef: '9001',
    vnp_Amount: '12500000',
    vnp_BankCode: 'NCB',
    vnp_PayDate: '20260921235959',
    vnp_TransactionNo: '123456',
    vnp_TransactionType: '01',
    vnp_TransactionStatus: '00',
    vnp_OrderInfo: 'Query transaction, tranid=9001',
    vnp_PromotionCode: '',
    vnp_PromotionAmount: '',
    ...overrides,
  };
}

function signedResponse(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const response = queryResponse(overrides);
  return {
    ...response,
    vnp_SecureHash: signVnPayQueryDrResponse(response, HASH_SECRET),
  };
}

function jsonResponse(payload: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mockHttpClient(): jest.MockedFunction<VnPayHttpClient> {
  return jest.fn() as jest.MockedFunction<VnPayHttpClient>;
}

function provider(
  fetcher: VnPayHttpClient,
  requestId = 'QUERYREQUEST001',
): VnPayPaymentProvider {
  return new VnPayPaymentProvider(
    config,
    () => NOW,
    fetcher,
    () => requestId,
  );
}

describe('VNPay QueryDR signing', () => {
  it('uses the official ordered pipe-delimited request signature source', () => {
    const params = {
      vnp_RequestId: 'QUERYREQUEST001',
      vnp_Version: '2.1.0',
      vnp_Command: 'querydr',
      vnp_TmnCode: 'TESTTMNC',
      vnp_TxnRef: '9001',
      vnp_TransactionDate: '20260921235959',
      vnp_CreateDate: '20260922084640',
      vnp_IpAddr: '127.0.0.1',
      vnp_OrderInfo: 'Query transaction, tranid=9001',
    };

    expect(buildVnPayQueryDrRequestSignatureSource(params)).toBe(
      'QUERYREQUEST001|2.1.0|querydr|TESTTMNC|9001|20260921235959|20260922084640|127.0.0.1|Query transaction, tranid=9001',
    );
    expect(signVnPayQueryDrRequest(params, HASH_SECRET)).toBe(
      '1d5c9d57047e3164a28a0a0704b002f8f6d66cd616393510d8876d40ffbaf00cc565c6cb026b861d85268fa22c09cd5489807671f7712f2c0ab246753cbc9683',
    );
  });

  it('preserves empty optional response fields in the checksum source', () => {
    const response = queryResponse({
      vnp_PromotionCode: '',
      vnp_PromotionAmount: '',
    });

    expect(buildVnPayQueryDrResponseSignatureSource(response)).toBe(
      'response-9001|querydr|00|Query successful|TESTTMNC|9001|12500000|NCB|20260921235959|123456|01|00|Query transaction, tranid=9001||',
    );
    expect(signVnPayQueryDrResponse(response, HASH_SECRET)).toBe(
      '98e67999f64eba0edbb57c83c4218761dc0016e7468139ed01d56a60e8fdaf61531ce68f906c421f72f16f7fb49ef13a0961b783fb08c7c74e72c1bb5c3d3f1d',
    );
  });
});

describe('VnPayPaymentProvider QueryDR client', () => {
  it('posts a canonical request and returns a trusted paid observation', async () => {
    const fetcher = mockHttpClient().mockResolvedValue(
      jsonResponse(signedResponse()),
    );
    const result = await provider(fetcher).queryTransaction(attempt());

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(config.apiUrl);
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
    });

    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    expect(body).toMatchObject({
      vnp_RequestId: 'QUERYREQUEST001',
      vnp_Version: '2.1.0',
      vnp_Command: 'querydr',
      vnp_TmnCode: 'TESTTMNC',
      vnp_TxnRef: '9001',
      vnp_TransactionNo: '123456',
      vnp_TransactionDate: '20260921235959',
      vnp_CreateDate: '20260922084640',
      vnp_IpAddr: '127.0.0.1',
      vnp_OrderInfo: 'Query transaction, tranid=9001',
    });
    expect(body.vnp_SecureHash).toBe(
      signVnPayQueryDrRequest(body, HASH_SECRET),
    );
    expect(body.vnp_SecureHash).not.toContain(HASH_SECRET);

    expect(result).toMatchObject({
      provider: 'vnpay',
      queryRequestStatus: 'success',
      transactionStatus: 'paid',
      providerOrderReference: '9001',
      providerTransactionIdentity: '123456',
      amountMinor: 125000n,
      currency: 'VND',
      responseCode: '00',
      transactionStatusCode: '00',
      trusted: true,
    });
    expect(result.paidAt).toEqual(new Date('2026-09-21T16:59:59.000Z'));
    expect(
      JSON.stringify(result, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain(HASH_SECRET);
  });

  it('accepts omitted optional response fields as empty signed segments', async () => {
    const response = queryResponse();
    delete response.vnp_PromotionCode;
    delete response.vnp_PromotionAmount;
    const fetcher = mockHttpClient().mockResolvedValue(
      jsonResponse({
        ...response,
        vnp_SecureHash: signVnPayQueryDrResponse(response, HASH_SECRET),
      }),
    );

    await expect(provider(fetcher).queryTransaction(attempt())).resolves.toMatchObject({
      transactionStatus: 'paid',
      trusted: true,
    });
  });

  it('uses a generated bounded request id when no deterministic test factory is supplied', () => {
    const requestId = createVnPayQueryDrRequestId();
    expect(requestId).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(createVnPayQueryDrRequestId()).not.toBe(requestId);
  });

  it.each([
    ['payos provider', { provider: 'payos' }],
    ['string provider reference', { providerOrderCode: '9001' }],
    ['USD currency', { currency: 'USD' }],
    ['zero amount', { amountMinor: 0n }],
    ['zero provider reference', { providerOrderCode: 0n }],
  ])('rejects unsafe %s input before HTTP', async (_name, overrides) => {
    const fetcher = mockHttpClient();
    await expect(
      provider(fetcher).queryTransaction(
        attempt(overrides as Partial<VnPayQueryDrAttempt>),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request', retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed when VNPay is disabled', async () => {
    const fetcher = mockHttpClient();
    const disabled = new VnPayPaymentProvider(
      { ...config, environment: 'disabled' },
      () => NOW,
      fetcher,
    );

    await expect(disabled.queryTransaction(attempt())).rejects.toMatchObject({
      code: 'disabled',
      retryable: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['amount', { vnp_Amount: '12500001' }],
    ['status', { vnp_TransactionStatus: '02' }],
    ['transaction reference', { vnp_TxnRef: '9002' }],
  ])('rejects tampered %s before consuming provider facts', async (_name, overrides) => {
    const response = signedResponse();
    Object.assign(response, overrides);
    const fetcher = mockHttpClient().mockResolvedValue(jsonResponse(response));

    await expect(provider(fetcher).queryTransaction(attempt())).rejects.toMatchObject({
      code: 'invalid_response_signature',
      retryable: false,
    });
  });

  it('validates merchant, reference, known transaction identity, and amount after checksum', async () => {
    for (const overrides of [
      { vnp_TmnCode: 'OTHER' },
      { vnp_TxnRef: '9002' },
      { vnp_TransactionNo: '654321' },
      { vnp_Amount: '12500100' },
    ]) {
      const fetcher = mockHttpClient().mockResolvedValue(
        jsonResponse(signedResponse(overrides as unknown as Record<string, string>)),
      );
      await expect(provider(fetcher).queryTransaction(attempt())).rejects.toMatchObject({
        code: 'provider_fact_mismatch',
        retryable: false,
      });
    }
  });

  it.each([
    ['00', 'paid'],
    ['01', 'pending'],
    ['02', 'failed'],
    ['04', 'reversed'],
    ['07', 'fraud_suspected'],
    ['55', 'unknown'],
  ] as const)('maps transaction status %s to %s without mutating state', async (status, expected) => {
    const fetcher = mockHttpClient().mockResolvedValue(
      jsonResponse(signedResponse({ vnp_TransactionStatus: status })),
    );
    const input = attempt();
    const result = await provider(fetcher).queryTransaction(input);

    expect(result.transactionStatus).toBe(expected);
    expect(input).toEqual(attempt());
  });

  it.each([
    ['91', 'not_found'],
    ['94', 'duplicate_request'],
    ['97', 'provider_error'],
    ['99', 'provider_error'],
  ] as const)('maps QueryDR response code %s to %s', async (responseCode, expected) => {
    const fetcher = mockHttpClient().mockResolvedValue(
      jsonResponse(
        signedResponse({
          vnp_ResponseCode: responseCode,
          vnp_Amount: '',
          vnp_TransactionNo: '',
          vnp_TransactionStatus: '',
        }),
      ),
    );

    await expect(provider(fetcher).queryTransaction(attempt())).resolves.toMatchObject({
      queryRequestStatus: expected,
      transactionStatus: 'unknown',
      trusted: true,
    });
  });

  it('rejects malformed, zero, and overflowing provider amounts', async () => {
    for (const amount of ['not-a-number', '0', '9999999999999']) {
      const fetcher = mockHttpClient().mockResolvedValue(
        jsonResponse(signedResponse({ vnp_Amount: amount })),
      );
      await expect(provider(fetcher).queryTransaction(attempt())).rejects.toMatchObject({
        code: 'malformed_response',
      });
    }
  });

  it('rejects an invalid response checksum before identity or amount checks', async () => {
    const response = signedResponse({ vnp_Amount: 'not-a-number' });
    response.vnp_SecureHash = '0'.repeat(128);
    const fetcher = mockHttpClient().mockResolvedValue(jsonResponse(response));

    await expect(provider(fetcher).queryTransaction(attempt())).rejects.toMatchObject({
      code: 'invalid_response_signature',
    });
  });

  it('maps timeout and malformed/network responses to sanitized typed errors', async () => {
    jest.useFakeTimers();
    try {
      const timeoutFetcher = mockHttpClient().mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
          }),
      );
      const pending = provider(timeoutFetcher).queryTransaction(attempt(), {
        timeoutMs: 1,
      });
      const timeoutAssertion = expect(pending).rejects.toMatchObject({
        code: 'network_timeout',
        retryable: true,
      });
      await jest.advanceTimersByTimeAsync(1);
      await timeoutAssertion;

      const malformedFetcher = mockHttpClient().mockResolvedValue(
        new Response('not-json', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      );
      await expect(provider(malformedFetcher).queryTransaction(attempt())).rejects.toMatchObject({
        code: 'malformed_response',
        retryable: false,
      });

      const oversizedFetcher = mockHttpClient().mockResolvedValue(
        new Response('{}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(64 * 1024 + 1),
          },
        }),
      );
      await expect(provider(oversizedFetcher).queryTransaction(attempt())).rejects.toMatchObject({
        code: 'malformed_response',
        retryable: false,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('never logs secrets or sends a request to an arbitrary host', async () => {
    const fetcher = mockHttpClient().mockRejectedValue(new Error('network'));
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(provider(fetcher).queryTransaction(attempt())).rejects.toMatchObject({
        code: 'provider_unavailable',
        retryable: true,
      });
      await expect(provider(fetcher).queryTransaction(attempt())).rejects.toBeInstanceOf(
        VnPayQueryDrError,
      );
      expect(fetcher.mock.calls[0][0]).toBe(config.apiUrl);
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining(HASH_SECRET));
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining(HASH_SECRET));
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
