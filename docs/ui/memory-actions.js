function typedReviewError(error) {
  return {
    code: error?.code || 'memory.review.failed',
    message: error?.message || 'Memory candidate review failed',
    ownerId: error?.ownerId || 'memory-coordinator',
    nextAction: error?.nextAction || 'inspect the candidate and retry the review',
  }
}

export function bindMemoryReviewAction({
  button,
  candidateId,
  decision,
  readReason,
  review,
  refresh,
  showError,
}) {
  button.addEventListener('click', async () => {
    const decisionReason = readReason()?.trim()
    if (!decisionReason || button.disabled) return
    button.disabled = true
    try {
      await review(candidateId, decision, decisionReason)
      await refresh()
    } catch (error) {
      showError(typedReviewError(error))
    } finally {
      button.disabled = false
    }
  })
}
