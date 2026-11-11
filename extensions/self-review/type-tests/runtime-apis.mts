import type { Delivery } from "../src/lib/delivery.mjs";
import { hunkAnchorRange } from "../src/lib/diff.mjs";
import type { ReviewService } from "../src/lib/review-service.mjs";

declare const delivery: Delivery;
const busy: boolean | null = delivery.busy;
// @ts-expect-error Delivery busy state is unknown until the first session event.
const definitelyBusy: boolean = delivery.busy;

const range = hunkAnchorRange({ rows: [] });
if (range) {
    range.startLine;
}
// @ts-expect-error Empty hunks may have no anchor range.
const requiredRange: NonNullable<typeof range> = range;

declare const service: ReviewService;
async function deliveryChoice(): Promise<void> {
    const choice = await service.setDeliveryChoice("review", null);
    const supported: "immediate" | "batch" | null = choice;
    // @ts-expect-error Resetting an ask-mode review returns null.
    const requiredChoice: "immediate" | "batch" = choice;
    void [supported, requiredChoice];
}

void [busy, definitelyBusy, deliveryChoice];
