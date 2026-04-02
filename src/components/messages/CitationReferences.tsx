import React from 'react'
import { Box, Link, Text } from '../../ink.js'
import { buildCitationDisplayItems } from '../../utils/citations.js'

type Props = {
  citations?: readonly unknown[] | null
}

export function CitationReferences({ citations }: Props): React.ReactNode {
  const { items, overflow } = buildCitationDisplayItems(citations)
  if (items.length === 0) {
    return null
  }

  return (
    // Render references as a separate block so the original assistant text
    // stays untouched while citations still become visible and clickable.
    <Box flexDirection="column" gap={0} marginTop={1} paddingLeft={2}>
      <Text dimColor={true}>References</Text>
      {items.map((item, index) => (
        <Box key={`${item.text}:${item.url ?? index}`} flexDirection="row">
          <Text dimColor={true}>{`${index + 1}. `}</Text>
          {item.url ? (
            <Link
              url={item.url}
              fallback={`${item.text} - ${item.url}`}
            >
              {item.text}
            </Link>
          ) : (
            <Text dimColor={true}>{item.text}</Text>
          )}
        </Box>
      ))}
      {overflow > 0 && <Text dimColor={true}>{`+${overflow} more`}</Text>}
    </Box>
  )
}
