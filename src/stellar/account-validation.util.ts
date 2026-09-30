import { BadRequestException } from "@nestjs/common";
import { Horizon } from "@stellar/stellar-sdk";

interface HorizonLookupError {
  response?: {
    status?: number;
  };
}

export async function assertFundedAccount(
  server: Horizon.Server,
  publicKey: string,
  network: string
): Promise<void> {
  let account: Awaited<ReturnType<Horizon.Server["loadAccount"]>>;
  try {
    account = await server.loadAccount(publicKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as HorizonLookupError)?.response?.status === 404) {
      throw new BadRequestException({
        error: `Stellar account ${publicKey} does not exist on ${network}. Fund/activate it with XLM and retry.`,
      });
    }
    throw new BadRequestException({
      error: `Could not verify Stellar account ${publicKey} on ${network}; retry when Horizon is available. ${message}`,
    });
  }

  const hasNativeBalance = account.balances.some(
    (balance) => balance.asset_type === "native" && Number(balance.balance) > 0
  );
  if (!hasNativeBalance) {
    throw new BadRequestException({
      error: `Stellar account ${publicKey} has no positive native XLM balance on ${network}. Fund it with XLM and retry.`,
    });
  }
}
