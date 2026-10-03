import { useEffect, useState } from "react";
import { TERRA_CLASSIC_MAINNET } from "../lib/onrampConfig";
import { useLatestRequest } from "./useLatestRequest";

// Terra Classic's burn tax (the tax module's burn_tax_rate - 1.5% when
// checked live 2026-10-03) as a fraction scaled by 1e18, for exact bigint
// math. It's charged when the LUNC/USTC route contract pays the coins out
// to the recipient: a real 1,497 LUNC return transfer (2026-10-03) landed
// as 1,474.545. Read live rather than hardcoded since governance can change
// it. CW20 tokens (TERRA) aren't taxed.
export const RATE_SCALE = 10n ** 18n;

function parseDecimalE18(value: string): bigint {
  const [whole, frac = ""] = value.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac)) throw new Error("Unexpected tax rate format.");
  return BigInt(whole) * RATE_SCALE + BigInt(frac.slice(0, 18).padEnd(18, "0"));
}

export type BurnTaxRateState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; rateE18: bigint };

export function useTerraBurnTaxRate(): BurnTaxRateState {
  const [state, setState] = useState<BurnTaxRateState>({ status: "loading" });
  const { start, isCurrent } = useLatestRequest();

  useEffect(() => {
    const req = start();
    fetch(`${TERRA_CLASSIC_MAINNET.lcd}/terra/tax/v1beta1/burn_tax_rate`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: { tax_rate?: unknown }) => {
        if (typeof json.tax_rate !== "string") throw new Error("Unexpected tax rate response.");
        const rateE18 = parseDecimalE18(json.tax_rate);
        if (rateE18 >= RATE_SCALE) throw new Error("Unexpected tax rate.");
        if (isCurrent(req)) setState({ status: "loaded", rateE18 });
      })
      .catch(() => {
        if (isCurrent(req)) setState({ status: "error" });
      });
  }, [start, isCurrent]);

  return state;
}
