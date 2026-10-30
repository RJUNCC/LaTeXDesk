// LaTeXDesk: the FigureData model from Overleaf's figure modal (the React modal itself isn't ported;
// figures are edited with LaTeXDesk's toolbar Figure dialog)
import { ChangeSet } from '@codemirror/state'


type NestedReadonly<T> = {
  readonly [P in keyof T]: NestedReadonly<T[P]>
}

type FigureDataProps = {
  from: number
  to: number
  caption: {
    from: number
    to: number
  } | null
  label: { from: number; to: number } | null
  width?: number
  unknownGraphicsArguments?: string
  graphicsCommandArguments: {
    from: number
    to: number
  } | null
  graphicsCommand: { from: number; to: number }
  file: {
    from: number
    to: number
    path: string
  }
}

function mapFromTo<T extends { from: number; to: number } | null>(
  position: T,
  changes: ChangeSet
) {
  if (!position) {
    return position
  }
  return {
    ...position,
    from: changes.mapPos(position.from),
    to: changes.mapPos(position.to),
  }
}

export class FigureData {
  // eslint-disable-next-line no-useless-constructor
  constructor(private props: NestedReadonly<FigureDataProps>) {}

  public get from() {
    return this.props.from
  }

  public get to() {
    return this.props.to
  }

  public get caption() {
    return this.props.caption
  }

  public get label() {
    return this.props.label
  }

  public get width() {
    return this.props.width
  }

  public get unknownGraphicsArguments() {
    return this.props.unknownGraphicsArguments
  }

  public get graphicsCommandArguments() {
    return this.props.graphicsCommandArguments
  }

  public get graphicsCommand() {
    return this.props.graphicsCommand
  }

  public get file() {
    return this.props.file
  }

  map(changes: ChangeSet): FigureData {
    return new FigureData({
      from: changes.mapPos(this.from),
      to: changes.mapPos(this.to),
      caption: mapFromTo(this.caption, changes),
      label: mapFromTo(this.label, changes),
      graphicsCommand: mapFromTo(this.graphicsCommand, changes),
      width: this.width,
      file: mapFromTo(this.file, changes),
      graphicsCommandArguments: mapFromTo(
        this.graphicsCommandArguments,
        changes
      ),
      unknownGraphicsArguments: this.unknownGraphicsArguments,
    })
  }
}
