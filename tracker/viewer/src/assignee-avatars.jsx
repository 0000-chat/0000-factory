import { Avatar, AvatarFallback, AvatarImage } from "./components/ui/avatar.tsx";
import { AvatarStack } from "./components/kibo-ui/avatar-stack/index.tsx";
import { useRouteContext } from "@tanstack/react-router";
import { normalizePersonIdentity, resolvePerson } from "./person-identity.ts";

const AVATAR_SIZES = { xs: 18, sm: 24, md: 32, lg: 40 };

function initialsFor(value) {
  const parts = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  const letters = parts
    .map(part => part.match(/[\p{L}\p{N}]/u)?.[0])
    .filter(Boolean)
    .slice(0, 2);
  return (letters.join("") || "?").toLocaleUpperCase();
}

export function resolveAssigneePerson(team, owner, ownerName) {
  return resolvePerson(team, owner, ownerName);
}

export function AssigneeAvatars({ owner, ownerName, imageUrl = null, size = "sm", showName = false }) {
  const team = useRouteContext({ strict: false, select: context => context.data.team });
  const ownerValue = String(owner ?? "").trim();
  const normalizedOwner = normalizePersonIdentity(ownerValue);
  if (!ownerValue || !normalizedOwner || normalizedOwner === "unassigned") return null;

  const person = resolveAssigneePerson(team, ownerValue, ownerName);
  const normalizedName = normalizePersonIdentity(ownerName);
  const displayName = String(person?.name ?? person?.fullName ?? (normalizedName && normalizedName !== "unassigned" ? ownerName : ownerValue)).trim() || "Unknown assignee";
  const pixelSize = typeof size === "number" ? size : AVATAR_SIZES[size] ?? AVATAR_SIZES.sm;
  const imageSource = imageUrl || person?.avatarUrl || null;

  return (
    <span
      className="assignee-avatars inline-flex min-w-0 items-center gap-2"
      role="img"
      aria-label={`Assigned to ${displayName}`}
      title={displayName}
    >
      <AvatarStack className="assignee-avatar-stack" size={pixelSize} aria-hidden="true">
        <Avatar className="size-full border-2 border-background bg-muted text-[0.55rem] font-semibold text-muted-foreground">
          {imageSource ? <AvatarImage src={imageSource} alt="" /> : null}
          <AvatarFallback>{initialsFor(displayName)}</AvatarFallback>
        </Avatar>
      </AvatarStack>
      {showName ? <span className="truncate text-xs">{displayName}</span> : null}
    </span>
  );
}
