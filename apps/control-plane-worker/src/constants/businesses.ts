export const SEEDED_BUSINESS_IDS = {
  cycloid: "295d2abc-d10b-4662-b84d-7bfa66242882",
  cycloidQa: "b004178c-58e4-421b-a6b9-43b410fc64ec",
  armory: "16c3b431-927c-487e-83b2-d8c59036b1f9",
  detailDev: "cb7d76a7-1189-4b00-83fc-023b6c6ddf53",
  geneparmigiana: "7a00684f-15ee-4871-83d3-3842909bd0da",
  jagritc: "e78c5850-ca52-4f8b-aa54-cd8010c7f3ad",
  jaikondapalli: "667f14b1-8686-4246-8a5e-01eae3f24962",
  kirubarajan: "9a7d5cd6-bee7-4a71-a358-4ccae607c771",
  localEval: "3d5e4bd3-404e-481e-9b11-996cd6633792",
  mshkodra: "081226aa-6b6b-49ce-9990-6d8744ed547d",
  pranaykotian: "85c3f196-2ed2-4535-af8e-e6187c2ea74f",
  samyu: "57485b0c-f7de-461a-8f9b-8b8c7d938264",
  shreypjain: "5b39b1cc-19ed-48c6-b015-38aa2eec9202",
  ssreeni1: "08da635b-26bc-4a09-a480-c1221c345eed",
  varun901: "a6f6b912-dee9-4af2-94fd-7260271cff2b",
} as const;

export function businessIdsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  return left != null && right != null && left === right;
}

// Both the prod Cycloid business and the QA-seeded Cycloid business are
// internal/dogfood, not customers. QA seed assigns internal users to the QA
// business instead of prod, so any "is this us?" check must treat both the same.
const INTERNAL_ARCANIST_BUSINESS_IDS = [SEEDED_BUSINESS_IDS.cycloid, SEEDED_BUSINESS_IDS.cycloidQa] as const;

export function isInternalCycloidBusinessId(businessId: string): boolean {
  return INTERNAL_ARCANIST_BUSINESS_IDS.some((internalId) => businessIdsMatch(businessId, internalId));
}
