import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { errors } from "../errors.js";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type AddressResolver = (
  hostname: string
) => Promise<readonly ResolvedAddress[]>;

export interface ValidatedTarget extends ResolvedAddress {
  hostname: string;
}

const forbiddenV4 = new BlockList();
const forbiddenV6 = new BlockList();
const allowedGlobalV6 = new BlockList();
allowedGlobalV6.addSubnet("2000::", 3, "ipv6");

for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  forbiddenV4.addSubnet(address, prefix, "ipv4");
}

for (const [address, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8]
] as const) {
  forbiddenV6.addSubnet(address, prefix, "ipv6");
}

export const defaultAddressResolver: AddressResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.flatMap((answer) =>
    answer.family === 4 || answer.family === 6
      ? [{ address: answer.address, family: answer.family }]
      : []
  );
};

function normalizedHostname(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function forbiddenAddress(answer: ResolvedAddress): boolean {
  const detectedFamily = isIP(answer.address);
  if (detectedFamily !== answer.family) return true;
  return answer.family === 4
    ? forbiddenV4.check(answer.address, "ipv4")
    : !allowedGlobalV6.check(answer.address, "ipv6")
      || forbiddenV6.check(answer.address, "ipv6");
}

export async function assertPublicHttpTarget(
  url: URL,
  resolver: AddressResolver = defaultAddressResolver
): Promise<ValidatedTarget> {
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
  ) {
    throw errors.unsafeMedia();
  }

  const hostname = normalizedHostname(url);
  if (hostname.length === 0) throw errors.unsafeMedia();

  const numericFamily = isIP(hostname);
  let answers: readonly ResolvedAddress[];
  try {
    answers = numericFamily === 4 || numericFamily === 6
      ? [{ address: hostname, family: numericFamily }]
      : await resolver(hostname);
  } catch {
    throw errors.unsafeMedia();
  }
  if (answers.length === 0 || answers.some(forbiddenAddress)) {
    throw errors.unsafeMedia();
  }

  const selected = answers[0];
  if (selected === undefined) throw errors.unsafeMedia();
  return { hostname, address: selected.address, family: selected.family };
}
