/**
 * Five circular avatars with distinct colours is the entire mechanism by which
 * "five researchers" beats "five endpoints" perceptually (plan §4.1).
 * No agent ever renders without one.
 */
export function Avatar({ name, color, size = 34, dim = false }: {
  name: string; color: string; size?: number; dim?: boolean
}) {
  const initials = name.trim().slice(0, 1).toUpperCase()
  return (
    <div
      className="avatar"
      style={{
        width: size, height: size, background: color,
        fontSize: size * 0.42, opacity: dim ? 0.45 : 1,
      }}
      title={name}
    >
      {initials}
    </div>
  )
}
