export async function advanceExplicitInteraction(api, input) {
  let snapshot = await api.inspectExplicitInteraction(input.interactionId)
  if (snapshot.state === 'awaiting-clarification' && input.clarificationAnswer !== undefined) {
    snapshot = await api.answerExplicitClarification(input.interactionId, input.clarificationAnswer)
  }
  if (snapshot.state === 'received' || snapshot.state === 'matching') {
    snapshot = await api.interpretExplicitInput(input.interactionId)
  }
  return snapshot
}
