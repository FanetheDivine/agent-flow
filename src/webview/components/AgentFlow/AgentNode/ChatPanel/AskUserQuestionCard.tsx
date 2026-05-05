import { useMemo, useState, type FC } from 'react'
import { Button, Checkbox, Input, Popover, Radio, Tag } from 'antd'
import { CheckOutlined, EditOutlined, QuestionCircleOutlined } from '@ant-design/icons'
import { XMarkdown } from '@ant-design/x-markdown'
import type {
  AskUserQuestionInput,
  AskUserQuestionItem,
  AskUserQuestionOutput,
} from '@/common'

type Props = {
  input: AskUserQuestionInput
  mode: 'active' | 'historical'
  /** 历史态时展示用户之前选中的 label 列表（按 question 映射） */
  answeredValues?: Record<string, string[]>
  /** 历史态时是否由自由文本作答 */
  answeredByFreeText?: boolean
  onSubmit?: (output: AskUserQuestionOutput) => void
}

type Selections = Record<number, string[]>
type OtherState = { text: string }

const OTHER_LABEL = 'Other'
const OTHER_OPTION = { label: OTHER_LABEL, description: '自定义回答' }

function buildOutput(
  questions: AskUserQuestionItem[],
  selections: Selections,
  otherStates: Record<number, OtherState>,
): AskUserQuestionOutput {
  const answers: Record<string, string> = {}
  questions.forEach((q, i) => {
    const sel = selections[i] ?? []
    const o = otherStates[i]
    const effective = sel.map((s) => (s === OTHER_LABEL && o?.text ? o.text : s))
    answers[q.question] = effective.join(',')
  })
  return { questions, answers }
}

export const AskUserQuestionCard: FC<Props> = ({
  input,
  mode,
  answeredValues,
  answeredByFreeText,
  onSubmit,
}) => {
  const questions = useMemo(() => input.questions ?? [], [input.questions])
  const isActive = mode === 'active'
  const [selections, setSelections] = useState<Selections>({})
  const [otherStates, setOtherStates] = useState<Record<number, OtherState>>({})

  const allAnswered = useMemo(() => {
    return questions.every((_, i) => {
      const sel = selections[i] ?? []
      if (sel.length === 0) return false
      if (sel.includes(OTHER_LABEL)) {
        const o = otherStates[i]
        if (!o || !o.text.trim()) return false
      }
      return true
    })
  }, [questions, selections, otherStates])

  const handleRadioChange = (qIdx: number, value: string) => {
    if (!isActive) return
    setSelections((prev) => ({ ...prev, [qIdx]: [value] }))
    if (value === OTHER_LABEL) {
      setOtherStates((prev) =>
        prev[qIdx] ? prev : { ...prev, [qIdx]: { text: '' } },
      )
    } else {
      setOtherStates((prev) => {
        if (!(qIdx in prev)) return prev
        const next = { ...prev }
        delete next[qIdx]
        return next
      })
    }
  }

  const handleCheckboxChange = (qIdx: number, values: string[]) => {
    if (!isActive) return
    setSelections((prev) => ({ ...prev, [qIdx]: values }))
    if (values.includes(OTHER_LABEL)) {
      setOtherStates((prev) =>
        prev[qIdx] ? prev : { ...prev, [qIdx]: { text: '' } },
      )
    } else {
      setOtherStates((prev) => {
        if (!(qIdx in prev)) return prev
        const next = { ...prev }
        delete next[qIdx]
        return next
      })
    }
  }

  const handleOtherTextChange = (qIdx: number, text: string) => {
    setOtherStates((prev) => ({ ...prev, [qIdx]: { text } }))
  }

  const handleManualSend = () => {
    if (!allAnswered) return
    onSubmit?.(buildOutput(questions, selections, otherStates))
  }

  // 历史态：根据 answeredValues 推断预置选项与 "Other" 的自定义文本
  const getHistoricalDisplay = (q: AskUserQuestionItem) => {
    const arr = answeredValues?.[q.question] ?? []
    const predefined = new Set(q.options.map((o) => o.label))
    const predefinedSelected = arr.filter((v) => predefined.has(v))
    const customText = arr.find((v) => !predefined.has(v))
    const values = customText ? [...predefinedSelected, OTHER_LABEL] : predefinedSelected
    return { values, customText: customText ?? '' }
  }

  return (
    <div className='flex flex-col gap-2 rounded-md border border-[#45475a] bg-[#181825] px-3 py-2'>
      <div className='flex items-center gap-2'>
        <QuestionCircleOutlined className='text-[#89b4fa]' />
        <span className='text-[11px] font-semibold text-[#cdd6f4]'>AI 提问</span>
        {mode === 'historical' && (
          <Tag
            color={answeredByFreeText ? 'blue' : 'success'}
            className='m-0 text-[10px]'
            icon={answeredByFreeText ? <EditOutlined /> : <CheckOutlined />}
          >
            {answeredByFreeText ? '以自由文本回答' : '已回答'}
          </Tag>
        )}
      </div>

      {questions.map((q, qIdx) => {
        const multi = !!q.multiSelect
        const historical = !isActive ? getHistoricalDisplay(q) : null
        const value = isActive ? selections[qIdx] ?? [] : historical!.values
        const otherSelected = value.includes(OTHER_LABEL)
        const otherText = isActive
          ? otherStates[qIdx]?.text ?? ''
          : historical?.customText ?? ''

        return (
          <div key={qIdx} className='flex flex-col gap-1.5'>
            <div className='flex items-start justify-between gap-2'>
              <XMarkdown
                className='x-markdown-dark text-[12px] text-[#cdd6f4]'
                content={q.question}
                openLinksInNewTab
                escapeRawHtml
              />
              {q.header && (
                <Tag color='processing' className='m-0 shrink-0 text-[10px]'>
                  {q.header}
                </Tag>
              )}
            </div>
            {multi ? (
              <Checkbox.Group
                value={value}
                disabled={!isActive}
                onChange={(vs) => handleCheckboxChange(qIdx, vs as string[])}
                className='flex flex-col gap-1'
              >
                {q.options.map((opt) => (
                  <OptionRow key={opt.label} option={opt}>
                    <Checkbox value={opt.label} />
                  </OptionRow>
                ))}
                <OptionRow option={OTHER_OPTION}>
                  <Checkbox value={OTHER_LABEL} />
                </OptionRow>
              </Checkbox.Group>
            ) : (
              <Radio.Group
                value={value[0]}
                disabled={!isActive}
                onChange={(e) => handleRadioChange(qIdx, e.target.value)}
                className='flex flex-col gap-1'
              >
                {q.options.map((opt) => (
                  <OptionRow key={opt.label} option={opt}>
                    <Radio value={opt.label} />
                  </OptionRow>
                ))}
                <OptionRow option={OTHER_OPTION}>
                  <Radio value={OTHER_LABEL} />
                </OptionRow>
              </Radio.Group>
            )}
            {otherSelected && (
              <div className='flex flex-col gap-1 pl-6'>
                <Input.TextArea
                  autoSize={{ minRows: 1, maxRows: 3 }}
                  value={otherText}
                  disabled={!isActive}
                  onChange={(e) => handleOtherTextChange(qIdx, e.target.value)}
                  placeholder='输入自定义回答...'
                  className='text-[11.5px]'
                />
              </div>
            )}
          </div>
        )
      })}

      {isActive && (
        <div className='flex justify-end'>
          <Button
            type='primary'
            size='small'
            disabled={!allAnswered}
            onClick={handleManualSend}
          >
            发送
          </Button>
        </div>
      )}
    </div>
  )
}

const OptionRow: FC<{
  option: { label: string; description: string; preview?: string }
  children: React.ReactNode
}> = ({ option, children }) => {
  const content = (
    <label className='flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 hover:bg-[#313244]'>
      {children}
      <span className='flex flex-col gap-0.5'>
        <span className='text-[11.5px] text-[#cdd6f4]'>{option.label}</span>
        {option.description && (
          <span className='text-[10px] leading-snug text-[#a6adc8]'>{option.description}</span>
        )}
      </span>
    </label>
  )
  if (option.preview) {
    return (
      <Popover
        content={
          <pre className='m-0 max-w-[320px] text-[10px] whitespace-pre-wrap'>{option.preview}</pre>
        }
        placement='right'
        trigger={['hover', 'focus']}
      >
        {content}
      </Popover>
    )
  }
  return content
}
