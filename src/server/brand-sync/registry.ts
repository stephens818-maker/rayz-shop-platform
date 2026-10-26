import type { SyncArea, SyncType } from "@/domain/brand-sync";
import { appAdapter, campaignTemplateAdapter, checkoutPromptsAdapter, loyaltyAdapter, milestonesAdapter, roleAdapter } from "./adapters/brand-only";
import { productAdapter, serviceAdapter } from "./adapters/catalog";
import { hoursAdapter, locationDefaultAdapter, receiptAdapter } from "./adapters/location";
import { cardFeeAdapter, taxesAdapter, tipsAdapter } from "./adapters/money";
import { automationAdapter } from "./adapters/automations";
import { closureAdapter } from "./adapters/closures";
import { fieldRuleAdapter, promptRuleAdapter } from "./adapters/rules";
import { serviceRuleAdapter } from "./adapters/service-rules";
import { listAdapter } from "./lists";
import { settingAdapter } from "./settings";
import type { AnyAdapter, SyncItem } from "./types";

export const ADAPTERS: Record<SyncType, AnyAdapter> = {
  service: serviceAdapter,
  product: productAdapter,
  card_fee: cardFeeAdapter,
  checkout_prompts: checkoutPromptsAdapter,
  milestones: milestonesAdapter,
  loyalty: loyaltyAdapter,
  location_default: locationDefaultAdapter,
  hours: hoursAdapter,
  campaign_template: campaignTemplateAdapter,
  taxes: taxesAdapter,
  tips: tipsAdapter,
  role: roleAdapter,
  receipt: receiptAdapter,
  app: appAdapter,
  setting: settingAdapter,
  list: listAdapter,
  service_rule: serviceRuleAdapter,
  closure: closureAdapter,
  automation: automationAdapter,
  field_rule: fieldRuleAdapter,
  prompt_rule: promptRuleAdapter,
};

export const areaOf = (a: AnyAdapter, item?: Pick<SyncItem, "area"> | null): SyncArea => item?.area ?? a.area;
