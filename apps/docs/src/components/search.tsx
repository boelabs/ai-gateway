"use client";

import { useStaticSearch } from "fumadocs-core/search/client/orama-static";
import { useI18n } from "fumadocs-ui/contexts/i18n";

import {
	SearchDialogContent,
	SearchDialogOverlay,
	SearchDialogHeader,
	SearchDialogClose,
	SearchDialogInput,
	SearchDialogIcon,
	SearchDialogList,
	type SharedProps,
	SearchDialog,
} from "fumadocs-ui/components/dialog/search";

export default function Search(props: SharedProps) {
	const { locale } = useI18n();
	const { search, onSearchChange, isLoading, data } = useStaticSearch({
		from: `/api/search/${locale ?? "en"}`,
	});

	return (
		<SearchDialog
			isLoading={isLoading}
			onSearchChange={onSearchChange}
			search={search}
			{...props}
		>
			<SearchDialogOverlay />
			<SearchDialogContent>
				<SearchDialogHeader>
					<SearchDialogIcon />
					<SearchDialogInput />
					<SearchDialogClose />
				</SearchDialogHeader>
				<SearchDialogList items={data?.items ?? null} />
			</SearchDialogContent>
		</SearchDialog>
	);
}
