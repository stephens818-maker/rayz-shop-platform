import { OPTIONS as options, getTipDeclarations, postTipDeclaration } from "@/server/staff-api/handlers";

export const GET = getTipDeclarations;
export const POST = postTipDeclaration;
export const OPTIONS = options;
