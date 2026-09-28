export const SHARE_PRICE_SCALE = 10_000n;

export function divideRoundNearest(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new RangeError("Denominator must be greater than zero");
  }
  return (numerator + denominator / 2n) / denominator;
}

export function calculatePoolShareValue(shares: bigint, sharePriceScaled: bigint): bigint {
  return divideRoundNearest(shares * sharePriceScaled, SHARE_PRICE_SCALE);
}

export function calculateSharesOut(amount: bigint, totalShares: bigint, totalUsdc: bigint): bigint {
  return (amount * totalShares) / totalUsdc;
}

export function calculateUsdcOut(shares: bigint, totalUsdc: bigint, totalShares: bigint): bigint {
  return (shares * totalUsdc) / totalShares;
}

export function formatFixedPercent(shares: bigint, totalShares: bigint): string {
  const scaledPercent = divideRoundNearest(shares * 1_000_000n, totalShares);
  const whole = scaledPercent / 10_000n;
  const fraction = (scaledPercent % 10_000n).toString().padStart(4, "0");
  return `${whole}.${fraction}`;
}
